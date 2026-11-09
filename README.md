# MycoBuild — конструктор билдов Mycopunk

Веб-конструктор раскладок модификаций на гексагональной сетке. Данные берутся напрямую из файлов игры.

## Структура

| Путь | Что это |
|---|---|
| `extractor/` | Python-экстрактор данных из установленной игры → `site/public/data/` |
| `site/` | Веб-приложение (Vite + React + TypeScript) |
| `site/src/core/` | Чистая логика без UI: гекс-геометрия, паттерны, правила, проверка размещения, характеристики |
| `site/src/data/` | Загрузка `game.json`, применение `patches.json`, валидация базы |
| `site/src/store/` | Состояние билда (Zustand, сохраняется в localStorage) и перетаскивания |
| `site/src/ui/` | Компоненты интерфейса |
| `site/tests/` | Тесты Vitest (ядро + проверка реальной базы) |
| `docs/` | Исследование, архитектура, разбор способностей |

## Данные

- `site/public/data/game.json` — генерируется экстрактором, руками не править.
- `site/public/data/patches.json` — ручные правки и добавления модов, оружия и персонажей (слияние по `id`).
- `site/public/data/stats.overrides.json` — ручные подписи характеристик (`en`/`ru`/`format`). Экстрактор только дописывает новые ключи.

Обновление базы после патча игры:

```bash
python -m venv .venv
.venv\Scripts\pip install -r extractor/requirements.txt
.venv\Scripts\python extractor/extract.py --game "C:/Program Files (x86)/Steam/steamapps/common/Mycopunk"
```

## Сайт

```bash
cd site
npm install
npm run dev      # http://localhost:5173
npm test         # тесты ядра
npm run build    # статическая сборка в site/dist
```

Управление: перетащите мод из каталога на сетку; R или колесо мыши — поворот на 60° (в том числе во время
перетаскивания); Del — убрать выбранный мод; двойной клик по карточке — поставить в первое свободное место;
перетаскивание мода за пределы сетки убирает его.

Сохранение: «Экспорт JSON» скачивает файл билда (формат `schemaVersion: 1`, см. `docs/03-architecture.md`),
«Импорт JSON» восстанавливает его, «Ссылка на билд» даёт адрес с билдом в `#b=…` (без сервера).
«Из сохранения игры» открывает `PlayerData.saxon` (`%USERPROFILE%\AppData\LocalLow\Pigeons at Play\Mycopunk\Profiles\default\`)
и загружает текущую раскладку или любой из трёх лоадаутов любого оружия / персонажа вместе с уровнями.
Файл читается только в браузере. Результаты сверки с игрой — `docs/04-verification.md`.
