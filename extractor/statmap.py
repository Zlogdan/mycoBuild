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


def build_element_rules(dll_path: str) -> dict:
    """For UpgradeProperty_* classes that roll an element: how to reproduce the roll from the instance seed.

    Returns {PropertyType: {"values": [...], "func": name, "count": n|None,
                            "cond": {"field": f, "equals": v} | None,
                            "steps": [{"field": f|None, "kind": "apply"|"next"}] }}
    `steps` are the Random-consuming calls on the property's own `ref Random` (ldarg.3) that happen before
    GetRandomEffect in the same method (copies of the Random do not count). The site turns them into a
    number of draws using the upgrade's data (an OverrideData field with method None does not roll).
    """
    pe = dnfile.dnPE(dll_path)
    T = pe.net.mdtables
    types = list(T.TypeDef)
    field_owner, method_owner = {}, {}
    for t in types:
        for f in t.FieldList:
            field_owner[f.row_index] = t.TypeName.value
        for m in t.MethodList:
            method_owner[m.row_index] = t.TypeName.value

    def callee(tok):
        tid, rid = tok.table, tok.rid
        if tid == MetadataTables.MethodDef.value:
            return method_owner.get(rid, "?"), T.MethodDef[rid - 1].Name.value
        if tid == MetadataTables.MemberRef.value:
            mr = T.MemberRef[rid - 1]
            cn = getattr(mr.Class.row, "TypeName", None)
            return (cn.value if cn is not None else "?"), mr.Name.value
        if tid == MetadataTables.MethodSpec.value:
            ms = T.MethodSpec[rid - 1]
            m = ms.Method
            row = m.row
            name = getattr(row, "Name", None)
            cls = getattr(getattr(row, "Class", None), "row", None) if hasattr(row, "Class") else None
            cn = getattr(cls, "TypeName", None) if cls is not None else None
            return (cn.value if cn is not None else "?"), (name.value if name is not None else "?")
        return "?", "?"

    def field_of(tok):
        if tok.table == MetadataTables.Field.value:
            return field_owner.get(tok.rid, "?"), T.Field[tok.rid - 1].Name.value
        if tok.table == MetadataTables.MemberRef.value:
            mr = T.MemberRef[tok.rid - 1]
            return "?", mr.Name.value
        return "?", "?"

    def int_of(ins):
        n = ins.opcode.name
        if n in ("ldc.i4", "ldc.i4.s"):
            return int(ins.operand)
        if n == "ldc.i4.m1":
            return -1
        if n.startswith("ldc.i4."):
            return int(n.rsplit(".", 1)[1])
        return None

    rules: dict = {}
    for t in types:
        owner = t.TypeName.value
        if not owner.startswith("UpgradeProperty_"):
            continue
        methods = sorted(t.MethodList, key=lambda m: 0 if m.row.Name.value == "Apply" else 1)
        for m in methods:
            row = m.row
            if not row.Rva:
                continue
            try:
                ins = list(CilMethodBody(_Reader(pe, row)).instructions)
            except MethodBodyFormatError:
                continue
            idx = next((i for i, x in enumerate(ins) if x.opcode.name in ("call", "callvirt") and isinstance(x.operand, Token)
                        and callee(x.operand)[0] == "UpgradeProperty" and callee(x.operand)[1].startswith("GetRandomEffect")), None)
            if idx is None:
                continue
            func = callee(ins[idx].operand)[1]
            count = None
            if func == "GetRandomEffectIncludingCryo":
                prev = int_of(ins[idx - 2]) if idx >= 2 else None  # (count, ref rand) overload: count is pushed before rand
                count = prev if isinstance(prev, int) and 1 <= prev <= 6 else None
            # condition: nearest "ldfld <own field> [ldfld data] [ldc K] beq/bne/brfalse/brtrue" before the call
            cond = None
            for j in range(idx - 1, max(0, idx - 14), -1):
                x = ins[j]
                if x.opcode.name in ("ldfld", "ldflda") and isinstance(x.operand, Token):
                    cls, fld = field_of(x.operand)
                    if cls != owner:
                        continue
                    nxt = ins[j + 1:j + 5]
                    k = next((int_of(y) for y in nxt if int_of(y) is not None), None)
                    if any(y.opcode.name.startswith(("bne", "beq")) for y in nxt) and k is not None:
                        cond = {"field": fld, "equals": k}
                    elif any(y.opcode.name.startswith(("brfalse", "brtrue")) for y in nxt):
                        cond = {"field": fld, "equals": 0}
                    if cond:
                        break
            # Random-consuming calls on ldarg.3 before the element roll
            steps = []
            last_field = None
            pushed_rand = False
            for x in ins[:idx]:
                n = x.opcode.name
                if n in ("ldfld", "ldflda") and isinstance(x.operand, Token):
                    cls, fld = field_of(x.operand)
                    if cls == owner:
                        last_field, pushed_rand = fld, False
                elif n == "ldarg.3":
                    pushed_rand = True
                elif n in ("ldloca.s", "ldloca", "ldloc.s", "ldloc", "ldloc.0", "ldloc.1", "ldloc.2", "ldloc.3"):
                    pass
                elif n in ("call", "callvirt") and isinstance(x.operand, Token):
                    cls, meth = callee(x.operand)
                    if meth in ("ApplyTo", "GetValue") and pushed_rand:
                        steps.append({"field": last_field, "kind": "apply"})
                    elif cls == "Random" and meth.startswith("Next") and pushed_rand:
                        steps.append({"field": None, "kind": "next"})
                    elif cls == "UpgradeProperty" and meth.startswith("GetRandomEffect") and pushed_rand:
                        steps.append({"field": None, "kind": "next"})
                    pushed_rand = False
            values = (list(range(1, count + 1)) + [10]) if func == "GetRandomEffectIncludingCryo" and count else \
                ([1, 2, 3, 10] if func == "GetRandomEffectIncludingCryo" else _RANDOM_EFFECT_SETS.get(func, []))
            rules[owner.removeprefix("UpgradeProperty_")] = {"values": values, "func": func, "count": count,
                                                            "cond": cond, "steps": steps, "method": row.Name.value}
            break
    return rules
