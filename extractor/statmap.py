"""
Static analysis of the game's UpgradeProperty_*.GetStatData() iterators.

Each property class builds its tooltip lines roughly like:

    var v = ModifyXxxFromPatternSize(this.fireRate, ...);
    yield return StatData.Create(TextBlocks.GetString("firerate"), v, ...).WithMultiplier().WithPatternRatio(...);

We disassemble the compiler-generated `<GetStatData>d__N.MoveNext` and pair every
`ldfld UpgradeProperty_X.field` with the following `ldstr "key"` + `TextBlocks.GetString`
and `StatData.Create*` call. Result:

    { "Accelerator_AKillRateReload": [
        {"field": "fireRate", "key": "firerate", "multiplier": true, "inverse": false, "patternScaled": true}, ...] }

The text keys are then resolved through the game's own TextBlocks localisation.
This is a heuristic (complex properties compute values from several fields), so every
entry can be overridden manually in site/data/stats.overrides.json.
"""
from __future__ import annotations

import dnfile
from dnfile.enums import MetadataTables
from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBase
from dncil.cil.error import MethodBodyFormatError
from dncil.clr.token import StringToken, Token


class _Reader(CilMethodBodyReaderBase):
    def __init__(self, pe, row):
        self.pe = pe
        self.offset = pe.get_offset_from_rva(row.Rva)

    def read(self, n):
        data = self.pe.get_data(self.pe.get_rva_from_offset(self.offset), n)
        self.offset += n
        return data

    def tell(self):
        return self.offset

    def seek(self, offset):
        self.offset = offset
        return offset


def _is_helper(field: str) -> bool:
    """Fields that tune how a value is applied rather than being a displayed value."""
    f = field.lower()
    # em*: multipliers for ElectromagneticDisruption levels (UpgradeProperty.ApplyEMMultiplier)
    em = field.startswith("em") and field[2:3].isupper()
    return em or f.startswith("modify") or f.endswith("stackmodifier") or f == "turbocharged"


def build_stat_map(dll_path: str) -> dict:
    pe = dnfile.dnPE(dll_path)
    T = pe.net.mdtables
    types = list(T.TypeDef)

    field_owner, method_owner = {}, {}
    for t in types:
        for f in t.FieldList:
            field_owner[f.row_index] = t.TypeName.value
        for m in t.MethodList:
            method_owner[m.row_index] = t.TypeName.value

    # parameter names of every method (to know whether a StatData.Create overload takes overrideType / format)
    params = {}
    for idx, m in enumerate(T.MethodDef, start=1):
        try:
            params[idx] = [p.row.Name.value for p in m.ParamList]
        except Exception:  # noqa: BLE001
            params[idx] = []

    enclosing = {}
    for nc in T.NestedClass or []:
        enclosing[nc.NestedClass.row_index] = nc.EnclosingClass.row_index

    def member_name(tok):
        tid, rid = tok.table, tok.rid
        if tid == MetadataTables.MemberRef.value:
            mr = T.MemberRef[rid - 1]
            cls = mr.Class.row
            cn = getattr(cls, "TypeName", None)
            return f"{cn.value if cn is not None else '?'}::{mr.Name.value}"
        if tid == MetadataTables.MethodDef.value:
            return f"{method_owner.get(rid, '?')}::{T.MethodDef[rid - 1].Name.value}"
        if tid == MetadataTables.Field.value:
            return f"{field_owner.get(rid, '?')}.{T.Field[rid - 1].Name.value}"
        return ""

    result: dict = {}
    for i, t in enumerate(types, start=1):
        if not t.TypeName.value.startswith("<GetStatData>d__"):
            continue
        owner_idx = enclosing.get(i)
        if not owner_idx:
            continue
        owner = types[owner_idx - 1].TypeName.value
        if not owner.startswith("UpgradeProperty_"):
            continue
        move_next = next((m.row for m in t.MethodList if m.row.Name.value == "MoveNext"), None)
        if move_next is None or not move_next.Rva:
            continue
        try:
            body = CilMethodBody(_Reader(pe, move_next))
        except MethodBodyFormatError:
            continue

        # The value field is the FIRST property field loaded after the previous StatData.Create*;
        # later loads are helpers: GetStackingModifier(stackModifier), Modify*FromPatternSize(..., modifyFromPatternSize),
        # ApplyEMMultiplier(emMultiplier) ...
        stats, loaded, key, pending_key, value_field = [], [], None, None, None
        # constants pushed after the label (TextBlocks.GetString) and before StatData.Create*
        after_label_ints, after_label_strs, seen_label = [], [], False
        for ins in body.instructions:
            op = ins.operand
            name = ins.opcode.name
            if seen_label and name.startswith("ldc.i4"):
                if name == "ldc.i4.m1":
                    after_label_ints.append(-1)
                elif name in ("ldc.i4", "ldc.i4.s"):
                    after_label_ints.append(int(op))
                else:
                    after_label_ints.append(int(name.rsplit(".", 1)[1]))
            if name in ("ldfld", "ldflda") and isinstance(op, Token):
                n = member_name(op)
                cls, _, fld = n.partition(".")
                if cls.startswith("UpgradeProperty") and fld and not fld.startswith("<"):
                    loaded.append(fld)
            elif name == "ldstr" and isinstance(op, StringToken):
                v = pe.net.user_strings.get(op.rid).value
                if seen_label:
                    after_label_strs.append(v)
                pending_key = v
            elif name in ("call", "callvirt") and isinstance(op, Token):
                n = member_name(op)
                if n == "TextBlocks::GetString" and pending_key is not None:
                    key, pending_key = pending_key, None
                    seen_label, after_label_ints, after_label_strs = True, [], []
                elif n == "UpgradeProperty::GetStackingModifier" and loaded:
                    loaded.pop()  # its argument is the stackModifier field, not a displayed value
                elif "FromPatternSize" in n and value_field is None:
                    # ModifyXxxFromPatternSize(value, ..., modifyFlag): the value is the last non-helper load
                    vals = [f for f in loaded if not _is_helper(f)]
                    value_field = vals[-1] if vals else None
                elif n.startswith("StatData::Create"):
                    candidates = [f for f in loaded if not _is_helper(f)]
                    pnames = params.get(op.rid, []) if op.table == MetadataTables.MethodDef.value else []
                    # overloads with an explicit OverrideType: it is the first int constant after the label
                    # (name, range, upgrade and rand are loads); otherwise the type comes from OverrideData.method
                    override_type = after_label_ints[0] if "overrideType" in pnames and after_label_ints else None
                    fmt = next((x for x in after_label_strs if "0" in x or "%" in x or "#" in x), None) if "format" in pnames else None
                    stats.append({
                        "field": value_field or (candidates[0] if candidates else None),
                        "key": key,
                        "multiplier": False,
                        "inverse": "Inverse" in n,
                        "patternScaled": False,
                        "overrideType": override_type,
                        "format": fmt,
                    })
                    loaded, key, value_field = [], None, None
                    seen_label, after_label_ints, after_label_strs = False, [], []
                elif n == "StatData::WithMultiplier" and stats:
                    stats[-1]["multiplier"] = True
                elif n == "StatData::WithPatternRatio" and stats:
                    stats[-1]["patternScaled"] = True
        if stats:
            result.setdefault(owner.removeprefix("UpgradeProperty_"), []).extend(stats)
    return result


# EffectType values (enum EffectType): Normal=0 Fire=1 Shock=2 Acid=3 Bees=8 Cryo=10
_RANDOM_EFFECT_SETS = {
    # UpgradeProperty.GetRandomEffect*: Random.Next(min, max) with exclusive max, remapped like the IL
    "GetRandomEffect": [1, 2, 3],
    "GetRandomEffectIncludingNormal": [0, 1, 2, 3],
    "GetRandomEffectIncludingNormalAndCryo": [0, 1, 2, 3, 10],
    "GetRandomEffectIncludingCryoAndBees": [1, 2, 3, 8, 10],
}


def build_element_map(dll_path: str) -> dict:
    """UpgradeProperty_* classes whose element is rolled per upgrade instance (UpgradeProperty.GetRandomEffect*),
    with the set of possible EffectType values. Scans the class's own methods and its nested iterator classes."""
    pe = dnfile.dnPE(dll_path)
    T = pe.net.mdtables
    types = list(T.TypeDef)
    method_owner = {}
    for t in types:
        for m in t.MethodList:
            method_owner[m.row_index] = t.TypeName.value
    enclosing = {nc.NestedClass.row_index: nc.EnclosingClass.row_index for nc in (T.NestedClass or [])}

    def top_owner(type_idx):
        while type_idx in enclosing:
            type_idx = enclosing[type_idx]
        return types[type_idx - 1].TypeName.value

    def callee(tok):
        if tok.table == MetadataTables.MethodDef.value:
            return method_owner.get(tok.rid, "?"), T.MethodDef[tok.rid - 1].Name.value
        if tok.table == MetadataTables.MemberRef.value:
            mr = T.MemberRef[tok.rid - 1]
            cn = getattr(mr.Class.row, "TypeName", None)
            return (cn.value if cn is not None else "?"), mr.Name.value
        return "?", "?"

    result: dict = {}
    for i, t in enumerate(types, start=1):
        owner = top_owner(i)
        if not owner.startswith("UpgradeProperty_"):
            continue
        for m in t.MethodList:
            row = m.row
            if not row.Rva:
                continue
            try:
                body = CilMethodBody(_Reader(pe, row))
            except MethodBodyFormatError:
                continue
            last_int = None
            for ins in body.instructions:
                name = ins.opcode.name
                if name.startswith("ldc.i4"):
                    if name in ("ldc.i4", "ldc.i4.s"):
                        last_int = int(ins.operand)
                    elif name == "ldc.i4.m1":
                        last_int = -1
                    else:
                        last_int = int(name.rsplit(".", 1)[1])
                elif name in ("call", "callvirt") and isinstance(ins.operand, Token):
                    cls, meth = callee(ins.operand)
                    if cls != "UpgradeProperty" or not meth.startswith("GetRandomEffect"):
                        continue
                    if meth == "GetRandomEffectIncludingCryo":
                        # two overloads: () -> Next(1,5), 4 => Cryo;  (count, ref rand) -> Next(1, count+2), count+1 => Cryo
                        n = last_int if isinstance(last_int, int) and 1 <= last_int <= 6 else 3
                        values = list(range(1, n + 1)) + [10]
                    else:
                        values = _RANDOM_EFFECT_SETS.get(meth)
                    if values:
                        key = owner.removeprefix("UpgradeProperty_")
                        result[key] = sorted(set(result.get(key, [])) | set(values))
    return result
