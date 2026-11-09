/**
 * Client-half preflight: the browser bundle talks to the Harness module table
 * (`window.__ModuleLoader__`). These tests execute it under a minimal DOM /
 * module-table stub and assert the two surfaces are wired to their slots:
 * connections live in `plugins.bundle.config`, the studio lives in `main` and
 * `sidebar.panellist`. They do not replace a real browser mount, but they catch
 * a broken factory, a wrong entry id, a missing registration, or run controls
 * leaking back into the settings card.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

const registered = []
let captured

globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      captured = options
    },
  },
}

const styles = []
globalThis.document = {
  createElement() {
    return { dataset: {}, textContent: "", remove() {} }
  },
  querySelector() {
    return undefined
  },
  getElementById() {
    return undefined
  },
  head: {
    appendChild(node) {
      styles.push(node)
    },
  },
}

await import("../lib/client.js")

class Component {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(update) {
    this.state = typeof update === "function" ? update(this.state) : { ...this.state, ...update }
  }
}

const ReactStub = {
  Component,
  createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useMemo: (factory) => factory(),
  useCallback: (factory) => factory,
  useRef: (initial) => ({ current: initial }),
}

const moduleExports = captured.factory((specifier) => {
  assert.equal(specifier, "react")
  return ReactStub
})

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === "string") {
    visit({ type: "text", value: node })
    return
  }
  if (typeof node !== "object") return
  if (typeof node.type === "function") {
    walk(node.type(node.props ?? {}), visit)
    return
  }
  visit({ type: node.type, props: node.props ?? {} })
  for (const child of node.children ?? []) walk(child, visit)
}

function collect(node) {
  const types = []
  const strings = []
  walk(node, (item) => {
    if (item.type === "text") strings.push(item.value)
    else types.push(item)
  })
  return { types, strings }
}

test("client factory registers under the dsh-q-image-studio entry id", () => {
  assert.equal(captured.id, "@u-cha/dsh-q-image-studio")
  assert.equal(moduleExports.name, "@u-cha/dsh-q-image-studio/client")
  assert.deepEqual(moduleExports.inject, ["slots"])
  assert.equal(typeof moduleExports.apply, "function")
})

test("client apply registers settings, main panel and sidebar entry", () => {
  const effects = []
  const registrations = []
  const ctx = {
    effect(fn) {
      effects.push(fn)
      return fn()
    },
    get(name) {
      if (name === "locale") return undefined
      assert.equal(name, "configForms")
      return {
        describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-q-image-studio" }] } }) }),
        get(entryId) {
          assert.equal(entryId, "dsh-q-image-studio")
          return { getSnapshot: () => ({ value: { providers: [{ id: "a" }] } }) }
        },
      }
    },
    slots: {
      inject(name, factory) {
        assert.ok(
          ["plugins.bundle.config", "main", "sidebar.panellist"].includes(name),
          name,
        )
        return factory()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }

  moduleExports.apply(ctx)

  assert.equal(registrations.length, 3)
  const settings = registrations.find((entry) => entry.options.name === "plugins.bundle.config")
  assert.ok(settings, "settings card registered")
  assert.equal(settings.options.key, "@u-cha/dsh-q-image-studio", "config slot key is the package name")
  assert.equal(settings.Component, moduleExports.__test.SettingsCardShell)

  const main = registrations.find((entry) => entry.options.name === "main")
  assert.ok(main, "main panel registered")
  assert.equal(main.options.key, "dsh-q-image-studio")
  assert.equal(typeof main.Component, "function")

  const sidebar = registrations.find((entry) => entry.options.name === "sidebar.panellist")
  assert.ok(sidebar, "sidebar entry registered")
  assert.equal(sidebar.options.id, "dsh-q-image-studio")
  assert.equal(typeof sidebar.options.label, "function")
  assert.ok(styles.some((node) => node.dataset.plugin === "dsh-q-image-studio"), "styles head injection")
})

test("settings card has profile fields only — no prompt, size, count or generate", () => {
  const scope = {
    getSnapshot: () => ({ value: { language: "ru", providers: [{ id: "a", label: "Мой" }], activeProviderId: "a" } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const t = {
    profile: "Профиль",
    add: "Добавить",
    remove: "Удалить",
    name: "Название",
    baseUrl: "Base URL",
    model: "Модель",
    key: "Ключ",
    keySaved: "Ключ сохранён",
    noKey: "Ключа нет",
    check: "Проверить",
    forget: "Забыть ключ",
    saveDir: "Папка сохранения",
    saveDirHint: "абсолютный путь",
    pickFolder: "Выбрать…",
    picking: "Открываю…",
  }
  const { types, strings } = collect(moduleExports.__test.SettingsCard({ scope, t }))
  assert.ok(types.some((item) => item.type === "input" && item.props.type === "password"), "key is a password input")
  assert.ok(types.some((item) => item.type === "button" && item.props.title === "Добавить"), "add profile")
  assert.equal(types.some((item) => item.type === "textarea"), false, "no prompt in settings")
  assert.ok(strings.includes("Папка сохранения"), "save folder field")
  assert.ok(strings.includes("Выбрать…"), "native folder picker button")
  const folder = types.find((item) => item.type === "input" && item.props.readOnly === true)
  assert.ok(folder, "save folder is read-only and changed only through the picker")
  const text = strings.join(" ")
  assert.doesNotMatch(text, /Сгенерировать|Generate|Размер|Size|Количество|Count/)
})

test("studio panel has mode, prompt, model, size modes, seed, transparent and generate", () => {
  const t = {
    title: "Q Image Studio",
    profile: "Профиль",
    profileHint: "подключение",
    model: "Модель",
    prompt: "Запрос",
    promptPlaceholder: "Что нарисовать?",
    sizeMode: "Режим размера",
    sizeAuto: "Авто",
    sizePreset: "Пресет",
    sizeManual: "Вручную",
    modeExact: "Точно",
    modeVibe: "Vibe Create",
    vibeCount: "4 генерации — дороже, чем одна",
    vibeProgress: "Готово {done} из {total}",
    longSide: "Длинная сторона",
    aspect: "Соотношение",
    width: "Ширина",
    height: "Высота",
    tariffBase: "базовый тариф",
    tariffHigh: "повышенный тариф",
    seed: "Сид",
    seedRandom: "Случайный",
    seedInvalid: "Сид должен быть целым числом",
    promptExtend: "Улучшение промпта",
    extendOff: "улучшение отключено",
    extendTransparent: "улучшение отключено для прозрачности",
    extendReturn: "вернуть",
    transparent: "Прозрачный фон",
    alphaWarning: "Нет прозрачных пикселей.",
    copy: "Копировать",
    copyImage: "Копировать картинку",
    copied: "Скопировано",
    openViewer: "Открыть",
    generateOne: "Генерировать 1 картинку",
    generateFour: "Генерировать 4 картинки",
    generateOneShort: "Генерировать · 1",
    generateFourShort: "Генерировать · 4",
    generating: "Генерирую…",
    close: "Закрыть",
    addFiles: "Файлы",
    references: "Референсы",
    results: "Результаты",
    result: "Результат",
    history: "История",
    historyHint: "наведите на карточку — появятся действия",
    lastGeneration: "Последняя генерация",
    canvasEmpty: "Здесь появится результат",
    dragRefs: "перетащите из истории",
    empty: "Пока пусто",
    removeRef: "Убрать",
    hidden: "Скрыто",
    showHidden: "Показать снова",
    details: "Подробности",
    download: "Скачать",
    reveal: "Показать в Finder",
    hide: "Скрыть",
    delete: "Удалить",
    needPrompt: "Нужен промпт",
    failed: "Не получилось",
    badFile: "Нужна картинка",
    limit: "Максимум 10",
    errorTitle: "Не удалось",
    noProvider: "Добавьте профиль",
    error404: "Модель {model} не найдена (HTTP 404).",
    errorAuth: "Ключ отклонён.",
    errorRate: "Слишком часто.",
    errorNetwork: "Нет связи.",
    errorKey: "Нет ключа.",
  }
  const scope = {
    getSnapshot: () => ({ value: { language: "ru", saveDir: "/tmp/images" } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const { types, strings } = collect(moduleExports.__test.StudioPanel({ t, scope, close: () => {} }))
  assert.ok(types.some((item) => item.type === "textarea"), "prompt field")
  assert.ok(types.some((item) => item.type === "input"), "model/size/count fields")
  assert.ok(strings.includes("Генерировать 1 картинку"), "generate button with count")
  assert.ok(strings.some((item) => item.includes("Референсы")), "reference picker")
  assert.ok(strings.includes("Результат") && strings.includes("История"), "canvas and history")
  const text = strings.join(" ")
  for (const label of ["Профиль", "Модель", "Запрос", "Режим размера", "Сид", "Прозрачный фон"]) {
    assert.ok(text.includes(label), `visible label ${label}`)
  }
  const generate = types.find((item) => item.type === "button" && item.props.className?.includes("is-generate"))
  assert.ok(generate, "primary generate button")
  assert.equal(generate.props.type, "submit")
  assert.ok(types.some((item) => item.props.className === "is-ref-zone"), "dashed references dropzone")
  assert.ok(types.some((item) => String(item.props.className ?? "").includes("is-page-actions")), "one actions row")
})

test("result cards show size and path, open on click and keep only compact actions", () => {
  const t = {
    openViewer: "Открыть в просмотрщике",
    copy: "Копировать",
    copyImage: "Копировать картинку",
    reveal: "Показать в Finder",
    hide: "Скрыть",
    delete: "Удалить",
    confirmDelete: "Нажмите ещё раз",
  }
  let opened = 0
  const card = moduleExports.__test.ResultCard({
    entry: { id: "abc", file: "/work/images/a.png", size: "1024x1024", label: "кот" },
    cwd: "/work",
    bytes: 1536,
    t,
    lang: "ru",
    onOpen: () => opened++,
    onCopy: () => {},
    onHide: () => {},
    onDelete: () => {},
    onReveal: () => {},
  })
  const { types, strings } = collect(card)
  const text = strings.join(" ")
  assert.match(text, /1,5 КБ/)
  assert.match(text, /1024x1024/)
  assert.ok(text.includes("/work/images/a.png"), "absolute path is shown")
  const titles = types.filter((item) => item.type === "button" || item.type === "a").map((item) => item.props.title)
  for (const label of ["Копировать картинку", "Показать в Finder", "Скрыть", "Удалить"]) {
    assert.ok(titles.includes(label), `${label} action`)
  }
  assert.equal(titles.includes("Скачать"), false, "no download action")
  assert.equal(titles.includes("Открыть"), false, "no dead Open button")
  const image = types.find((item) => item.type === "button" && item.props.className?.includes("is-card-image"))
  assert.ok(image, "image is a click target")
  image.props.onClick()
  assert.equal(opened, 1, "click opens the OS viewer")
  assert.ok(!types.some((item) => item.props.className?.includes("is-detail")), "no inline details panel")
})
test("file sizes and provider failures are localized and actionable", () => {
  const { formatFileSize, describeFailure } = moduleExports.__test
  assert.equal(formatFileSize(1536, "ru"), "1,5 КБ")
  assert.equal(formatFileSize(1536, "en"), "1.5 KB")
  assert.equal(formatFileSize(0, "ru"), "")
  const ru = {
    failed: "Не получилось",
    error404: "Модель {model} недоступна.",
    errorAuth: "Ключ отклонён.",
    errorForbidden: "Нет доступа к модели.",
    errorRate: "Слишком много запросов.",
    errorNetwork: "Нет связи с поставщиком.",
    errorKey: "Ключ не задан.",
    modelUnavailable: "недоступна на этом ключе",
    modelUnavailableShort: "недоступна",
  }
  assert.match(describeFailure("поставщик ответил HTTP 404", ru, "qwen-image-3.0"), /«qwen-image-3.0»[^]*HTTP 404/)
  assert.match(describeFailure("HTTP 401", ru), /Ключ отклонён\. HTTP 401/)
  assert.match(describeFailure("HTTP 429", ru), /Слишком много запросов\. HTTP 429/)
  assert.match(
    describeFailure("поставщик ответил HTTP 403 AllocationQuota.FreeTierOnly: The free quota has been exhausted", ru),
    /Нет доступа к модели\. HTTP 403 · AllocationQuota\.FreeTierOnly — The free quota has been exhausted/,
  )
  assert.match(
    describeFailure("поставщик ответил HTTP 401 InvalidApiKey: Invalid API-key provided", ru),
    /Ключ отклонён\. HTTP 401 · InvalidApiKey — Invalid API-key provided/,
  )
  assert.equal(describeFailure("fetch failed", ru), ru.errorNetwork)
  assert.equal(describeFailure("ключ не задан для профиля X", ru), ru.errorKey)
  assert.equal(describeFailure("странная ошибка", ru), "странная ошибка")
})

test("save folder accepts absolute and ~ paths but rejects empty and relative paths", () => {
  const normalize = moduleExports.__test.normalizeSaveDir
  assert.deepEqual(normalize("~/Images/Q-Image-Studio"), { ok: true, value: "~/Images/Q-Image-Studio" })
  assert.deepEqual(normalize("/Users/u/Pictures"), { ok: true, value: "/Users/u/Pictures" })
  assert.deepEqual(normalize("photos/2026"), { ok: false, error: "relative" })
  assert.deepEqual(normalize("../outside"), { ok: false, error: "relative" })
  assert.deepEqual(normalize(""), { ok: false, error: "empty" })
})

test("dismissed cards persist in localStorage and can be shown again", () => {
  const store = new Map()
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  }
  try {
    const key = moduleExports.__test.dismissedKey("/work/images")
    assert.match(key, /^dsh-q-image-studio:dismissed:\/work\/images$/)
    const entries = [{ id: "a" }, { id: "b" }]
    moduleExports.__test.writeDismissed(key, ["a"])
    assert.deepEqual(moduleExports.__test.readDismissed(key), ["a"])
    // A remount reads the same key: the hidden card stays hidden.
    assert.deepEqual(entries.filter((entry) => !moduleExports.__test.readDismissed(key).includes(entry.id)), [{ id: "b" }])
    moduleExports.__test.writeDismissed(key, [])
    assert.deepEqual(entries.filter((entry) => !moduleExports.__test.readDismissed(key).includes(entry.id)), entries)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test("a new profile has an empty user-assigned name and connection", () => {
  assert.deepEqual(moduleExports.__test.newProfile("p-1"), {
    id: "p-1",
    label: "",
    baseURL: "",
    model: "",
    apiKeyRef: "",
  })
})

test("a studio run sends per-run parameters, not a config patch", () => {
  const request = moduleExports.__test.buildPanelRequest({
    providerId: "p-1",
    prompt: "кот",
    model: "qwen-image-2.0",
    size: "1328x1328",
    references: [{ data: "data:image/png;base64,AA==" }],
    cwd: "/work",
  })
  assert.deepEqual(request, {
    providerId: "p-1",
    prompt: "кот",
    model: "qwen-image-2.0",
    size: "1328x1328",
    references: [{ data: "data:image/png;base64,AA==" }],
    transparent: false,
    promptExtend: true,
    cwd: "/work",
  })
  assert.equal("providers" in request, false)
  assert.equal("activeProviderId" in request, false)
  assert.equal("defaultSize" in request, false)
})

test("repeat runs keep earlier results and deduplicate by id", () => {
  const merged = moduleExports.__test.mergeResults(
    [{ id: "a", file: "images/a.png" }],
    [{ id: "b", file: "images/b.png" }, { id: "a", file: "images/a.png" }],
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["b", "a"])
})

test("a rejected settings write reports the Host-backed reason", async () => {
  const scope = {
    getSnapshot: () => ({ status: "unavailable", writable: false, revision: 7 }),
    set: async () => false,
  }
  await assert.rejects(
    () => moduleExports.__test.writeConfig(scope, { providers: [] }),
    /Host отклонил «providers»: namespace плагина не смонтирован, запись настроек запрещена, состояние формы: unavailable, ревизия 7/,
  )
  const throwing = { getSnapshot: () => ({}), set: async () => { throw new Error("stale revision 9") } }
  await assert.rejects(
    () => moduleExports.__test.writeConfig(throwing, { activeProviderId: "x" }),
    /Host отклонил «activeProviderId»: stale revision 9/,
  )
})

test("settings scope follows the mounted namespace, including an include: prefix", () => {
  const seen = []
  const ctx = {
    get(name) {
      assert.equal(name, "configForms")
      return {
        describe: () => ({
          getSnapshot: () => ({ view: { namespaces: [{ ns: "include:dsh-q-image-studio" }] } }),
        }),
        get(id) {
          seen.push(id)
          return { id }
        },
      }
    },
  }
  const scope = moduleExports.__test.resolveSettingsScope(ctx)
  assert.equal(seen[0], "include:dsh-q-image-studio")
  assert.equal(scope.id, "include:dsh-q-image-studio")
})

test("settings fallback is visible and read-only when the namespace is not ready", () => {
  const t = {
    profile: "Profile",
    baseUrl: "Base URL",
    model: "Model",
    keySaved: "Key saved",
    noKey: "No key",
    retry: "Retry",
    settingsUnavailable: "Settings are not ready yet.",
    noProvider: "Add a profile",
  }
  const { types, strings } = collect(
    moduleExports.__test.SettingsCard({ scope: moduleExports.__test.DEGRADED_SCOPE, t }),
  )
  const text = strings.join(" ")
  assert.ok(text.includes("Settings are not ready yet"), "read-only hint")
  assert.ok(strings.includes("Retry"), "retry action")
  assert.ok(types.some((item) => item.type === "button" && item.props.className === "is-btn"), "retry button")
  assert.ok(
    types.some(
      (item) =>
        item.type === "button" &&
        item.props["aria-haspopup"] === "listbox" &&
        item.props.disabled === true,
    ),
    "read-only profile dropdown",
  )
  assert.equal(moduleExports.__test.DEGRADED_SCOPE.getSnapshot(), moduleExports.__test.DEGRADED_SCOPE.getSnapshot())
})

test("settings scope store waits for a namespace that appears after apply", () => {
  const namespaceListeners = []
  let namespaces = []
  const formsAvailable = true
  const mirror = {
    getSnapshot: () => ({ view: { namespaces } }),
    subscribe(listener) {
      namespaceListeners.push(listener)
      return () => {}
    },
    ensure() {},
  }
  const form = {
    getSnapshot: () => ({ status: "ready", value: { providers: [{ id: "late" }] } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const forms = { describe: () => mirror, get: () => form }
  const ctx = {
    get(name) {
      assert.ok(name === "configForms" || name === "settingsScope", name)
      if (name === "settingsScope") return undefined
      return formsAvailable ? forms : undefined
    },
  }

  const store = moduleExports.__test.createSettingsScopeStore(ctx)
  const seen = []
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()?.status))
  assert.equal(store.getSnapshot().status, "unavailable", "starts as a stable read-only stub")

  namespaces = [{ ns: "dsh-q-image-studio" }]
  for (const listener of namespaceListeners) listener()
  assert.equal(store.getSnapshot().status, "ready", "late namespace is picked up through configForms")
  assert.ok(seen.length > 0, "subscribers are notified when the form appears")
  unsubscribe()
})

test("settings scope store also finds configForms when the service appears after apply", async () => {
  let formsAvailable = false
  const form = {
    getSnapshot: () => ({ status: "ready", value: { providers: [{ id: "later" }] } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const forms = {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-q-image-studio" }] } }),
      subscribe: () => () => {},
      ensure() {},
    }),
    get: () => form,
  }
  const ctx = {
    get(name) {
      assert.ok(name === "configForms" || name === "settingsScope", name)
      if (name === "settingsScope") return undefined
      return formsAvailable ? forms : undefined
    },
  }
  const store = moduleExports.__test.createSettingsScopeStore(ctx)
  const unsubscribe = store.subscribe(() => {})
  try {
    assert.equal(store.getSnapshot().status, "unavailable")
    formsAvailable = true
    await new Promise((resolve) => setTimeout(resolve, 360))
    assert.equal(store.getSnapshot().status, "ready", "the card retries until the form is served")
  } finally {
    unsubscribe()
  }
})

test("settings error boundary shows the error and a retry action", () => {
  const t = {
    retry: "Повторить",
    cardError: "Карточка настроек не открылась.",
    errorTitle: "Не удалось",
  }
  const boundary = new (moduleExports.__test.SettingsErrorBoundary)({ t, children: () => null })
  boundary.state = moduleExports.__test.SettingsErrorBoundary.getDerivedStateFromError(
    new Error("render exploded"),
  )
  const failure = boundary.render()
  assert.equal(failure.type, moduleExports.__test.CardFailure)
  assert.match(failure.props.message, /render exploded/)
  const { types, strings } = collect(moduleExports.__test.CardFailure(failure.props))
  const text = strings.join(" ")
  assert.ok(text.includes("Повторить"), "retry action")
  const alert = types.find((item) => item.props.role === "alert")
  assert.ok(alert, "failure stays inside a visible alert container")
  assert.ok(types.some((item) => item.type === "button"), "retry button")
})

test("public README has English and Russian guides, screenshot, and install command", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  assert.match(readme, /^# Q Image Studio/m, "English title first")
  const russian = readme.indexOf("## Русский")
  assert.ok(russian > 0, "Russian section exists")
  assert.ok(russian > readme.indexOf("## Install"), "Russian section follows the English part")
  assert.match(readme, /dsh plugin add @u-cha\/dsh-q-image-studio/, "one-line install command")
  assert.match(readme, /docs\/screenshot\.jpg/, "panel screenshot is linked")
  assert.doesNotMatch(readme, /grandpraline|\/Users\/|NOTES\.md|attempt/i, "no internal notes")
})

test("plugin page uses localized short detail documents instead of the full README", () => {
  const expected = { en: "docs/plugin-page.md", ru: "docs/plugin-page.ru.md" }
  for (const [language, file] of Object.entries(expected)) {
    const locale = JSON.parse(readFileSync(new URL(`../locale/${language}.json`, import.meta.url), "utf8"))
    assert.equal(locale.meta.detail, file, `${language} meta.detail`)
    const page = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    const lines = page.trim().split(/\r?\n/).filter(Boolean)
    assert.ok(lines.length >= 3 && lines.length <= 5, `${language} page has ${lines.length} non-empty lines`)
    assert.match(page, language === "ru" ? /сайдбар/i : /sidebar/i, "explains where the panel lives")
    assert.doesNotMatch(page, /^\s*(\||\d+\.)/m, "no tables or numbered instructions")
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    assert.ok(pkg.files.includes(file), `${file} is published`)
  }
  const ruPage = readFileSync(new URL("../docs/plugin-page.ru.md", import.meta.url), "utf8")
  assert.match(ruPage, /[А-Яа-я]/, "Russian page is actually Russian")
  assert.doesNotMatch(ruPage, /Generate and edit images|sidebar panel/, "no English body copy")
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  assert.ok(readme.split(/\r?\n/).length > 50, "full README stays for npm/GitHub")
})

test("provider failures render as a contained inline alert", () => {
  const { types, strings } = collect(
    moduleExports.__test.ErrorAlert({
      message: "Модель «qwen-image-3.0» не найдена (HTTP 404).",
      t: { errorTitle: "Не удалось" },
    }),
  )
  const alert = types.find((item) => item.props.role === "alert")
  assert.ok(alert, "alert has role=alert")
  assert.match(alert.props.className, /is-alert/)
  assert.ok(strings.includes("Не удалось"), "alert title")
  assert.ok(strings.join(" ").includes("HTTP 404"), "actionable reason")
})

test("panel styles use harness tokens and container queries, no hardcoded colors", () => {
  const css = moduleExports.__test.STYLE
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(css, /\b(rgb|hsl)\(/)
  assert.match(css, /--dsw-alias-label-primary/)
  assert.match(css, /--dsw-radius-md/)
  assert.match(css, /@container \(min-width: 440px\)/)
  assert.match(css, /@container \(max-width: 419px\)/)
  assert.match(css, /grid-template-columns: repeat\(auto-fit, minmax\(160px, 1fr\)\)/)
  assert.doesNotMatch(css, /transition:\s*all/)
})

test("plugin labels follow its own EN/RU config setting", () => {
  const make = (language) => ({
    getSnapshot: () => ({ value: { language, saveDir: "/tmp/images" } }),
    subscribe: () => () => {},
    set: async () => true,
  })
  const ru = collect(moduleExports.__test.StudioPanel({ scope: make("ru"), close: () => {} }))
  const en = collect(moduleExports.__test.StudioPanel({ scope: make("en"), close: () => {} }))
  assert.ok(ru.strings.includes("Генерировать 1 картинку"), "RU config gets russian actions")
  assert.ok(en.strings.includes("Generate 1 image"), "EN config gets english actions")
  assert.equal(ru.strings.includes("Generate"), false, "no english leakage in russian mode")
  const defaultEn = collect(moduleExports.__test.StudioPanel({ close: () => {} }))
  assert.ok(defaultEn.strings.includes("Generate 1 image"), "default language is English")
})

test("connection status uses animation, theme success/error colors and reduced motion", () => {
  const style = moduleExports.__test.STYLE
  assert.match(style, /\.is-status\.is-ok/, "success badge style")
  assert.match(style, /--dsw-alias-state-success-primary/, "success color comes from the theme")
  assert.match(style, /\.is-status\.is-bad/, "failure style")
  assert.match(style, /\.is-dots span/, "animated dots")
  assert.match(style, /@keyframes is-dot/, "dot animation")
  assert.match(style, /prefers-reduced-motion: reduce/, "reduced motion respected")
})

test("save-dir change cancels on refusal and retries with migration after confirmation", async () => {
  const { changeSaveDir } = moduleExports.__test
  const calls = []
  const post = async (route, body) => {
    calls.push({ route, body })
    if (body.migrate !== true) return { ok: false, code: "confirm-migration", count: 2, saveDir: "/new" }
    return { ok: true, saveDir: "/new", migrated: 2 }
  }
  const cancelled = await changeSaveDir({ saveDir: "/new", confirm: () => false, post })
  assert.equal(cancelled.cancelled, true)
  assert.equal(calls.length, 1, "no write happens without confirmation")

  calls.length = 0
  const accepted = await changeSaveDir({ saveDir: "/new", confirm: (count) => count === 2, post })
  assert.equal(accepted.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].body.migrate, true)
  assert.equal(calls[1].body.saveDir, "/new")
})

test("settings gate the model field until a successful check and warn outside Qwen", () => {
  const makeScope = (profile) => ({
    getSnapshot: () => ({
      value: {
        language: "en",
        saveDir: "/tmp/images",
        providers: [profile],
        activeProviderId: profile.id,
      },
    }),
    subscribe: () => () => {},
    set: async () => true,
  })
  const base = { id: "p1", label: "DashScope", baseURL: "https://proxy.test", model: "qwen-image-3.0", apiKeyRef: "K" }
  const unchecked = collect(moduleExports.__test.SettingsCard({ scope: makeScope(base) }))
  assert.ok(unchecked.strings.includes("This is not Qwen — other models are not guaranteed to work."), "qwen warning")
  const blocked = unchecked.types.find(
    (item) =>
      item.type === "button" &&
      item.props["aria-haspopup"] === "listbox" &&
      item.props.disabled === true,
  )
  assert.ok(blocked, "model listbox is disabled before verification")
  assert.ok(unchecked.strings.includes("Test the connection first."), "reason shown")

  const verified = collect(
    moduleExports.__test.SettingsCard({
      scope: makeScope({
        ...base,
        baseURL: "https://dashscope-intl.aliyuncs.com",
        verifiedAt: "2026-11-08T10:00:00.000Z",
        models: ["qwen-image-3.0", "qwen-image-2.1"],
      }),
    }),
  )
  assert.ok(
    verified.types.some(
      (item) => item.type === "button" && item.props["aria-haspopup"] === "listbox",
    ),
    "verified profile shows its model listbox",
  )
  assert.ok(verified.strings.includes("qwen-image-3.0"), "selected model is displayed")
  assert.ok(!verified.strings.includes("This is not Qwen — other models are not guaranteed to work."), "no warning on DashScope")
  assert.equal(verified.types.filter((item) => item.type === "select").length, 0, "no native selects")
})

test("language segment and animation setting are rendered from config", () => {
  const scope = {
    getSnapshot: () => ({
      value: { language: "ru", animations: false, saveDir: "/tmp/images", providers: [], activeProviderId: "" },
    }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const { types, strings } = collect(moduleExports.__test.SettingsCard({ scope }))
  assert.ok(strings.includes("Язык"), "language label")
  assert.ok(strings.includes("Анимации"), "animations label")
  assert.ok(strings.includes("EN") && strings.includes("RU"), "EN and RU segment buttons")
  assert.equal(strings.includes("Base URL"), false, "no English Base URL label in Russian")
  assert.equal(strings.includes("Save folder"), false, "no English save-folder label in Russian")
  assert.equal(strings.includes("Generate 1 image"), false, "no English generate label in Russian")
  const pressed = types.filter((item) => item.type === "button" && item.props["aria-pressed"] === true)
  assert.equal(pressed.length, 1, "one active segment")
  assert.ok(strings.indexOf("RU") >= 0)
  const checkbox = types.find((item) => item.type === "input" && item.props.type === "checkbox")
  assert.equal(checkbox.props.checked, false)
  assert.match(moduleExports.__test.STYLE, /\.is-page\.is-animating/)
  assert.match(moduleExports.__test.STYLE, /is-neon-spin 2\.8s linear infinite/)
  assert.match(moduleExports.__test.STYLE, /@keyframes is-neon-spin/)
  assert.match(moduleExports.__test.STYLE, /conic-gradient\(from var\(--qis-angle\)/)
  const reduced = moduleExports.__test.STYLE.slice(moduleExports.__test.STYLE.indexOf("prefers-reduced-motion"))
  assert.match(reduced, /is-animating \.is-generate::after \{ display: none; \}/)
})

test("preset sizes keep the long side, round the short side and explain invalid picks", () => {
  const { presetSize } = moduleExports.__test
  const hd = presetSize(1024, "16:9")
  assert.deepEqual({ width: hd.width, height: hd.height, size: hd.size, pixels: hd.pixels, valid: hd.valid }, {
    width: 1024,
    height: 576,
    size: "1024x576",
    pixels: 589824,
    valid: true,
  })
  const portrait = presetSize(1536, "9:16")
  assert.equal(portrait.size, "864x1536")
  const higher = presetSize(2048, "16:9")
  assert.equal(higher.valid, true)
  assert.equal(higher.highTariff, true)
  assert.match(higher.size, /^2048x/)
  const minHint = presetSize(384, "16:9")
  assert.equal(minHint.valid, false)
  assert.match(minHint.reason, /минимум 683 px для 16:9/)
})

test("manual sizes enforce step, range, area and 10:1 ratio", () => {
  const { manualSize } = moduleExports.__test
  assert.equal(manualSize(1024, 1024).valid, true)
  assert.match(manualSize(1000, 1024).reason, /шаг 32 px/)
  assert.match(manualSize(4096, 512).reason, /512…2048 px/)
  assert.match(manualSize(2048, 2048).reason, /площадь/)
  assert.equal(manualSize(2048, 512).valid, true)
  assert.equal(manualSize(512, 512).reason, "")
})

test("seed parsing accepts the full 31-bit range and random seeds stay valid", () => {
  const { parseSeed, randomSeed, __test } = moduleExports
  assert.equal(__test.parseSeed("0").value, 0)
  assert.equal(__test.parseSeed("2147483647").value, 2147483647)
  assert.equal(__test.parseSeed("-1").ok, false)
  assert.equal(__test.parseSeed("2147483648").ok, false)
  assert.equal(__test.parseSeed("1.5").ok, false)
  for (let index = 0; index < 20; index += 1) {
    const value = __test.randomSeed()
    assert.equal(Number.isInteger(value), true)
    assert.equal(value >= 0 && value <= 2147483647, true)
  }
  void parseSeed
  void randomSeed
})

test("transparent prompts use the exact wrapper", () => {
  assert.equal(
    moduleExports.__test.transparentPromptText("Кот в шляпе"),
    "This is an RGBA image with transparency. Кот в шляпе. The image has alpha channel and the background is transparent.",
  )
})

test("Vibe runs four jobs concurrently and one failure does not cancel the others", async () => {
  const { runVibe, VIBE_COUNT } = moduleExports.__test
  let started = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const finished = []
  const failures = []
  const progress = []
  const pending = runVibe({
    count: VIBE_COUNT,
    run: async (index) => {
      started += 1
      await gate
      if (index === 2) throw new Error("boom")
      return index
    },
    onResult: (value) => finished.push(value),
    onError: (error) => failures.push(error.message),
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(started, 4, "all four requests are in flight before any finishes")
  release()
  const outcome = await pending
  assert.deepEqual(outcome, { done: 4, failed: 1 })
  assert.equal(finished.length, 3)
  assert.deepEqual(failures, ["boom"])
  assert.deepEqual(progress, ["1/4", "2/4", "3/4", "4/4"])
})

test("prompt guide opens as a read-only modal with only a full-guide link", () => {
  const { guidePlainText, GuidePopover, TEXT } = moduleExports.__test
  const guide = guidePlainText()
  assert.match(guide, /subject \+ setting \+ style \+ camera \+ atmosphere \+ detail modifiers/)
  assert.match(guide, /distorted hands/)
  assert.match(guide, /COME PLAY BALL!/)
  assert.match(guide, /github\.com\/sceneworks/)
  assert.ok(!/[А-Яа-яЁё]/.test(guide), "guide text stays English")

  const { types, strings } = collect(
    GuidePopover({ t: TEXT.ru, lang: "ru", initiallyOpen: true }),
  )
  const text = strings.join(" ")
  assert.match(text, /Qwen Image Prompt Guide/)
  assert.match(text, /Промпт лучше писать по-английски/)
  assert.match(text, /Сам гайд — без перевода/)
  assert.ok(!text.includes("Скопировать"), "guide has no copy action")
  const buttons = types.filter((item) => item.type === "button")
  assert.ok(buttons.some((item) => item.props.className === "is-guide-close"), "close button in the header")
  assert.ok(!buttons.some((item) => /Скопировать|Copy/.test(String(item.children ?? ""))), "no copy button")
  const link = types.find((item) => item.type === "a")
  assert.ok(link, "full guide link")
  assert.match(link.props.href, /prompt-guides\/qwen-image\.md$/)
  assert.equal(link.props.target, "_blank")
  assert.ok(!types.some((item) => item.props?.className?.includes("is-guide-actions")), "no footer action row")

  const english = collect(GuidePopover({ t: TEXT.en, lang: "en", initiallyOpen: true }))
  const englishText = english.strings.join(" ")
  assert.ok(!englishText.includes("Промпт лучше писать по-английски"), "no RU note in EN")
  assert.ok(!englishText.includes("Copy"), "no copy action in EN")
})

test("guide modal uses a centered 720px card and scrolls its body", () => {
  const { STYLE } = moduleExports.__test
  assert.match(STYLE, /\.is-guide-modal \{[^}]*position: fixed; inset: 0; z-index: 120;/s)
  assert.match(STYLE, /\.is-guide-modal \{[^}]*backdrop-filter: blur\(3px\)/s)
  assert.match(STYLE, /\.is-guide-card \{[^}]*width: min\(720px, 100%\); max-height: 88vh;/s)
  assert.match(STYLE, /\.is-guide-scroll \{[^}]*overflow-y: auto; overscroll-behavior: contain;/s)
  assert.match(STYLE, /\.is-guide-foot \{[^}]*border-top:/s)
})

test("feed groups newest cards by calendar day", () => {
  const { groupByDay } = moduleExports.__test
  const now = new Date("2026-11-08T12:00:00")
  const groups = groupByDay(
    [
      { id: "a", createdAt: "2026-11-08T10:00:00" },
      { id: "b", createdAt: "2026-11-08T09:00:00" },
      { id: "c", createdAt: "2026-11-07T22:00:00" },
      { id: "d", createdAt: "2026-10-01T10:00:00" },
    ],
    "ru",
    now,
  )
  assert.deepEqual(groups.map((group) => group.label), ["Сегодня", "Вчера", "1 октября"])
  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.id)), [["a", "b"], ["c"], ["d"]])
})

test("result card exposes prompt actions, readable fields and reference state", () => {
  const { ResultCard, TEXT } = moduleExports.__test
  const t = TEXT.en
  const { types, strings } = collect(
    ResultCard({
      entry: {
        id: "abc",
        file: "/work/images/a.png",
        size: "1024x576",
        model: "qwen-image-3.0",
        seed: 42,
        transparent: true,
        promptExtend: false,
        prompt: "A cat in a hat",
      },
      cwd: "/work",
      bytes: 1536,
      t,
      lang: "en",
      inRefs: true,
      onOpen() {},
      onCopy() {},
      onCopyPrompt() {},
      onHide() {},
      onDelete() {},
      onReveal() {},
      onUseSettings() {},
      onDevelop() {},
      onReference() {},
    }),
  )
  const text = strings.join(" ")
  for (const expected of ["Model", "Size", "Seed", "Transparent", "Prompt enhancement", "A cat in a hat", "Use these settings", "Develop", "in references"]) {
    assert.ok(text.includes(expected), `card shows ${expected}`)
  }
  const article = types.find((item) => item.type === "article")
  assert.match(article.props.className, /is-in-refs/)
  assert.match(article.props.className, /is-transparent/)
  const enabled = types.filter((item) => item.type === "button" && !item.props.disabled).map((item) => item.props.title ?? "")
  assert.ok(enabled.includes("Copy image"))
  const refButton = types.find(
    (item) => item.type === "button" && item.props.className?.includes("is-card-btn") && item.props.disabled,
  )
  assert.ok(refButton, "reference action is disabled once selected")
})

test("image copy reports success only after the Host confirms the clipboard", async () => {
  const { copyImageEntry } = moduleExports.__test
  const t = { copied: "Скопировано", failed: "Не получилось" }
  const flashes = []
  const errors = []
  const ok = await copyImageEntry({
    entry: { id: "a" },
    copy: async () => ({ ok: true, bytes: 12 }),
    flash: (value) => flashes.push(value),
    fail: (value) => errors.push(value),
    t,
  })
  assert.equal(ok, true)
  assert.deepEqual(flashes, ["Скопировано"])
  assert.deepEqual(errors, [])
  const failed = await copyImageEntry({
    entry: { id: "b" },
    copy: async () => ({ ok: false, error: "буфер не подтвердил PNG" }),
    flash: (value) => flashes.push(value),
    fail: (value) => errors.push(value),
    t,
  })
  assert.equal(failed, false)
  assert.deepEqual(flashes, ["Скопировано"], "no toast without confirmation")
  assert.deepEqual(errors, ["буфер не подтвердил PNG"])
  const thrown = await copyImageEntry({
    entry: { id: "c" },
    copy: async () => { throw new Error("offline") },
    flash: (value) => flashes.push(value),
    fail: (value) => errors.push(value),
    t,
  })
  assert.equal(thrown, false)
  assert.deepEqual(flashes, ["Скопировано"])
  assert.equal(errors.at(-1), "offline")
})

test("generate button counts images for both modes and has a narrow label", () => {
  const { generateLabels, TEXT, STYLE } = moduleExports.__test
  assert.deepEqual(generateLabels("exact", TEXT.ru), {
    full: "Генерировать 1 картинку",
    short: "Генерировать · 1",
  })
  assert.deepEqual(generateLabels("vibe", TEXT.ru), {
    full: "Генерировать 4 картинки",
    short: "Генерировать · 4",
  })
  assert.equal(generateLabels("exact", TEXT.en).full, "Generate 1 image")
  assert.equal(generateLabels("vibe", TEXT.en).full, "Generate 4 images")
  assert.match(STYLE, /@container \(max-width: 359px\) \{\s*\.is-gen-full \{ display: none; \}\s*\.is-gen-short \{ display: inline; \}/s)
})

test("dropdown renders a listbox with options, selected value and manual entry", () => {
  let manualPicked = 0
  const { types, strings } = collect(
    moduleExports.__test.Dropdown({
      id: "dsh-test-dropdown",
      value: "beta",
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      onChange: () => {},
      manual: { label: "Enter manually", onSelect: () => { manualPicked += 1 } },
      defaultOpen: true,
      ariaLabel: "Pick one",
    }),
  )
  const trigger = types.find((item) => item.type === "button" && item.props["aria-haspopup"] === "listbox")
  assert.ok(trigger, "dropdown trigger")
  assert.equal(trigger.props["aria-expanded"], true)
  assert.equal(trigger.props["aria-label"], "Pick one")
  assert.ok(strings.includes("Beta"), "selected value is shown")
  const options = types.filter((item) => item.type === "button" && item.props.role === "option")
  assert.equal(options.length, 3, "two models plus manual entry")
  assert.equal(options[0].props["aria-selected"], false)
  assert.equal(options[1].props["aria-selected"], true)
  const manual = options.find((item) => String(item.props.className).includes("is-dropdown-manual"))
  assert.ok(manual, "manual item is last")
  manual.props.onClick()
  assert.equal(manualPicked, 1, "manual item invokes callback")
})

test("modelsLabel uses correct Russian and English plurals", () => {
  const label = moduleExports.__test.modelsLabel
  assert.equal(label(1, "ru"), "модель")
  assert.equal(label(2, "ru"), "модели")
  assert.equal(label(4, "ru"), "модели")
  assert.equal(label(5, "ru"), "моделей")
  assert.equal(label(11, "ru"), "моделей")
  assert.equal(label(21, "ru"), "модель")
  assert.equal(label(22, "ru"), "модели")
  assert.equal(label(25, "ru"), "моделей")
  assert.equal(label(1, "en"), "model")
  assert.equal(label(2, "en"), "models")
})

test("client has no native select elements and binds the long side value", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8")
  assert.ok(!/h\(\s*"select"/.test(source), "no h(select)")
  const { types, strings } = collect(
    moduleExports.__test.Dropdown({
      id: "dsh-test-long-side",
      value: 1536,
      options: [768, 1024, 1536, 2048].map((value) => ({ value, label: `${value} px` })),
      onChange: () => {},
      defaultOpen: true,
    }),
  )
  assert.ok(strings.includes("1536 px"), "selected long side is rendered")
  const selected = types.find(
    (item) => item.type === "button" && item.props.role === "option" && item.props["aria-selected"] === true,
  )
  assert.ok(selected, "selected option is marked")
  assert.ok(strings.includes("1536 px"), "selected option label")
})

test("dropdown placement flips up only when room below is short", () => {
  const up = moduleExports.__test.dropdownUp
  assert.equal(up({ top: 120, bottom: 160 }, 900), false)
  assert.equal(up({ top: 600, bottom: 650 }, 900), true)
  assert.equal(up({ top: 100, bottom: 140 }, 300), false)
  assert.equal(up({ top: 200, bottom: 240 }, 300), true)
})

test("t25 settings: rename hint, autosave note and trash confirm labels exist in RU and EN", () => {
  const { TEXT, profileName } = moduleExports.__test
  for (const [lang, words] of Object.entries({
    ru: ["Название профиля", "Мой профиль", "имя видно только вам", "Изменения сохраняются автоматически", "Сохранено", "Удалить профиль", "Удалить?", "Профиль удалён"],
    en: ["Profile name", "My profile", "only you see this name", "Changes are saved automatically", "Saved", "Delete profile", "Delete?", "Profile deleted"],
  })) {
    for (const word of words) {
      assert.ok(Object.values(TEXT[lang]).includes(word), `${lang}: ${word}`)
    }
  }
  assert.equal(profileName({ label: "" }, 1, TEXT.ru), "Профиль 2")
  assert.equal(profileName({ label: "Мой DashScope" }, 0, TEXT.ru), "Мой DashScope")
  assert.equal(profileName({ label: "   " }, 0, TEXT.en), "Profile 1")
})

test("t25 profile deletion: first click only arms, expiry never deletes, second click within 3s deletes", () => {
  const { deleteClickDecision, DELETE_CONFIRM_MS } = moduleExports.__test
  assert.equal(DELETE_CONFIRM_MS, 3000)
  let deletions = 0
  const click = (armedAt, now) => {
    if (deleteClickDecision(armedAt, now) === "delete") deletions += 1
    return deleteClickDecision(armedAt, now)
  }
  // first click: no arm timestamp yet, nothing is deleted
  assert.equal(click(0, 1000), "arm")
  assert.equal(deletions, 0)
  const armedAt = 1000
  assert.equal(deleteClickDecision(armedAt, 1200), "delete")
  assert.equal(deleteClickDecision(armedAt, armedAt + DELETE_CONFIRM_MS), "delete")
  // after the window the click merely re-arms; it never deletes by itself
  assert.equal(click(armedAt, armedAt + DELETE_CONFIRM_MS + 1), "arm")
  assert.equal(deletions, 0)
  assert.equal(click(armedAt, armedAt + 100), "delete")
  assert.equal(deletions, 1)
})

test("t25 profile deletion clears the vault key first and only then rewrites providers", async () => {
  const { deleteProfileWithKey } = moduleExports.__test
  const order = []
  const providers = [
    { id: "p-1", label: "A" },
    { id: "p-2", label: "B" },
  ]
  const result = await deleteProfileWithKey({
    profile: providers[0],
    providers,
    clear: async (id) => {
      order.push(`clear:${id}`)
      return { ok: true }
    },
    write: async (patch) => {
      order.push(`write:${patch.activeProviderId}`)
      assert.deepEqual(patch.providers.map((row) => row.id), ["p-2"])
    },
    errorText: "clear failed",
  })
  assert.deepEqual(order, ["clear:p-1", "write:p-2"])
  assert.equal(result.activeId, "p-2")
})

test("t25 profile deletion keeps the profile when clear-key fails", async () => {
  const { deleteProfileWithKey } = moduleExports.__test
  let writes = 0
  await assert.rejects(
    deleteProfileWithKey({
      profile: { id: "p-1" },
      providers: [{ id: "p-1" }, { id: "p-2" }],
      clear: async () => ({ ok: false, error: "волт недоступен" }),
      write: async () => {
        writes += 1
      },
      errorText: "clear failed",
    }),
    /волт недоступен/,
  )
  assert.equal(writes, 0, "provider config must not be rewritten when key cleanup fails")

  await assert.rejects(
    deleteProfileWithKey({
      profile: { id: "p-1" },
      providers: [{ id: "p-1" }],
      clear: async () => {
        throw new Error("vault offline")
      },
      write: async () => {
        writes += 1
      },
    }),
    /vault offline/,
  )
  assert.equal(writes, 0)
})

test("t25 settings render autosave hint, profile-name hint and trash delete affordance", () => {
  const { SettingsCard, TEXT } = moduleExports.__test
  const scope = {
    getSnapshot: () => ({
      value: {
        providers: [
          { id: "p-1", label: "", baseURL: "https://dashscope-intl.aliyuncs.com", model: "qwen-image-3.0", models: [], verifiedAt: "" },
          { id: "p-2", label: "Второй", baseURL: "", model: "" },
        ],
        activeProviderId: "p-1",
        language: "ru",
        animations: true,
      },
      revision: 1,
      status: "ready",
    }),
    subscribe: () => () => {},
    set: async () => true,
    retry: () => {},
  }
  const { types, strings } = collect(SettingsCard({ scope, t: TEXT.ru }))
  assert.ok(strings.includes("Изменения сохраняются автоматически"), "autosave note")
  assert.ok(strings.includes("Название профиля"), "profile name label")
  assert.ok(strings.includes("имя видно только вам"), "name hint")
  assert.ok(strings.includes("Профиль 1"), "blank profile fallback name")
  const deleteButton = types.find((item) => item.type === "button" && item.props.title === "Удалить профиль")
  assert.ok(deleteButton, "delete-profile button with title")
  assert.equal(deleteButton.props["aria-label"], "Удалить профиль")
  assert.equal(deleteButton.props.className.includes("is-profile-delete"), true)
})

test("t25 delete affordance renders trash first and a red confirm state after the first click", () => {
  const { ProfileDeleteButton, SaveNote, TEXT } = moduleExports.__test
  const idle = collect(ProfileDeleteButton({ armed: false, t: TEXT.ru, onClick: () => {}, disabled: false }))
  const idleButton = idle.types.find((item) => item.type === "button")
  assert.equal(idleButton.props.title, "Удалить профиль")
  assert.equal(idleButton.props.className.includes("is-danger"), false)
  assert.ok(idle.types.some((item) => item.props["data-icon"] === "delete"), "trash icon shown")

  const armed = collect(ProfileDeleteButton({ armed: true, t: TEXT.ru, onClick: () => {}, disabled: false }))
  const armedButton = armed.types.find((item) => item.type === "button")
  assert.equal(armedButton.props.title, "Удалить?")
  assert.equal(armedButton.props.className.includes("is-danger"), true)
  assert.ok(armed.strings.includes("Удалить?"))
})

test("t25 autosave footer shows the permanent hint, green Saved and red error", () => {
  const { SaveNote, TEXT } = moduleExports.__test
  const base = collect(SaveNote({ t: TEXT.ru, notice: "", error: "" }))
  assert.ok(base.strings.includes("Изменения сохраняются автоматически"))
  assert.equal(base.types.some((item) => item.props.role === "status"), false)

  const saved = collect(SaveNote({ t: TEXT.ru, notice: "Сохранено", error: "" }))
  const status = saved.types.find((item) => item.props.role === "status")
  assert.equal(status.props.className.includes("is-ok"), true)
  assert.ok(saved.strings.includes("Сохранено"))

  const failed = collect(SaveNote({ t: TEXT.ru, notice: "", error: "Настройка отклонена" }))
  const alert = failed.types.find((item) => item.props.role === "alert")
  assert.equal(alert.props.className, "is-error")
})

test("transparency warnings distinguish missing alpha channel from zero transparent pixels", () => {
  const { alphaWarningText } = moduleExports.__test
  const copy = { alphaWarning: "no pixels", alphaNoChannel: "no channel" }
  assert.equal(alphaWarningText({ transparent: true, alphaChecked: true, hasAlpha: false }, copy), "no channel")
  assert.equal(alphaWarningText({ transparent: true, alphaChecked: true, hasAlpha: true, transparentPixels: false }, copy), "no pixels")
  assert.equal(alphaWarningText({ transparent: true, alphaChecked: true, hasAlpha: true, transparentPixels: true }, copy), "")
  assert.equal(alphaWarningText({ transparent: false, alphaChecked: true, hasAlpha: false }, copy), "")
})


test("language switch is explicit, fixed width and does not share the label column", () => {
  const style = moduleExports.__test.STYLE
  assert.match(style, /\.is-seg-btn\.is-active \{[^}]*background: var\(--qis-accent\);/s, "active segment filled with accent")
  assert.match(style, /\.is-seg-btn\.is-active \{[^}]*color: var\(--dsw-static-neutral-bluish-00\);/s, "contrast text on active segment")
  assert.match(style, /\.is-seg-btn \{[^}]*opacity: \.62;/s, "inactive segment dimmed")
  assert.match(style, /\.is-lang-block \{[^}]*width: 168px;[^}]*flex: 0 0 168px;/s, "language block fixed width")
  assert.match(style, /\.is-lang-label \{[^}]*width: 76px;/s, "language label fixed width")
  assert.match(style, /\.is-field \{[^}]*grid-template-columns: 120px minmax\(0, 1fr\);/s, "settings label column fixed")
  assert.match(style, /\.is-field > span \{[^}]*min-height: 38px;/s, "label column keeps control height")
  assert.match(style, /\.is-size-label \{[^}]*width: 100px;/s, "size label width shared by both languages")
  assert.match(style, /\.is-size-controls > \.is-seg \{[^}]*width: 184px;/s, "size segment fixed width")
  assert.match(style, /\.is-file \{[^}]*width: 136px;/s, "references button fixed width")
})

test("generator is compact and has a single scroll area", () => {
  const style = moduleExports.__test.STYLE
  assert.match(style, /\.is-prompt \{[^}]*height: 48px;/s, "prompt is three short rows")
  assert.match(style, /\.is-mode-row \{/, "mode row")
  assert.match(style, /\.is-seed-row \{/, "seed and transparency row")
  assert.match(style, /\.is-size-controls \{/, "size controls share rows")
  assert.doesNotMatch(style, /max-height: min\(62vh/, "feed has no nested max-height")
  assert.match(style, /\.is-panel \{[^}]*overflow: hidden;/s, "panel does not scroll")
  assert.match(style, /\.is-feed \{[^}]*overflow-y: auto;/s, "only feed scrolls")
  assert.match(style, /\.is-form \{[^}]*flex: none;/s, "form is static, not sticky")
  assert.doesNotMatch(style, /\.is-form \{[^}]*position: sticky/s, "no sticky form")
})

test("animation class is absent when config animations is false", () => {
  const { panelClass } = moduleExports.__test
  assert.equal(panelClass(false, true), "is-page is-no-motion")
  assert.equal(panelClass(true, false), "is-page")
  assert.equal(panelClass(true, true), "is-page is-animating")
  assert.match(moduleExports.__test.STYLE, /\.is-no-motion \.is-generate[^{]*\{[^}]*animation: none;/s)
})

test("panel root receives is-no-motion when animations are disabled", () => {
  const scope = {
    getSnapshot: () => ({
      status: "available",
      writable: true,
      value: {
        language: "en",
        animations: false,
        providers: [{ id: "p1", label: "P", baseURL: "https://x.test", model: "m", apiKeyRef: "K", models: [], verifiedAt: "" }],
        activeProviderId: "p1",
        saveDir: "/tmp",
      },
    }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const { types } = collect(moduleExports.__test.StudioPanel({ scope, close: () => {} }))
  const root = types.find((item) => String(item.props.className ?? "").startsWith("is-page"))
  assert.ok(root, "panel root rendered")
  assert.match(root.props.className, /is-no-motion/)
})

test("settings root also disables animations when the config flag is off", () => {
  const scope = {
    getSnapshot: () => ({
      status: "available",
      writable: true,
      value: { language: "en", animations: false, providers: [], activeProviderId: "", saveDir: "/tmp" },
    }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const { types } = collect(moduleExports.__test.SettingsCard({ scope, t: moduleExports.__test.TEXT.en }))
  const root = types.find((item) => String(item.props.className ?? "").startsWith("is-settings"))
  assert.ok(root, "settings root rendered")
  assert.match(root.props.className, /is-no-motion/)
})

test("studio renders as a full page with control column, canvas and history", () => {
  const scope = {
    getSnapshot: () => ({
      value: {
        language: "en",
        animations: true,
        providers: [{ id: "p1", label: "P", baseURL: "https://x.test", model: "m", apiKeyRef: "K", models: ["m"], verifiedAt: "now" }],
        activeProviderId: "p1",
        saveDir: "/tmp/images",
      },
    }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const { types } = collect(moduleExports.__test.StudioPanel({ scope, close: () => {} }))
  const root = types.find((item) => String(item.props.className ?? "").startsWith("is-page"))
  assert.ok(root, "page root")
  assert.equal(typeof root.props.onPaste, "function", "clipboard paste handler on page")
  assert.ok(types.some((item) => item.props.className === "is-page-side"), "control column")
  assert.ok(types.some((item) => item.props.className === "is-page-main"), "canvas + history column")
  assert.ok(types.some((item) => item.props.className === "is-canvas-panel"), "canvas panel")
  assert.ok(types.some((item) => item.props.className === "is-history-panel"), "history panel")
  const zone = types.find((item) => String(item.props.className ?? "").startsWith("is-ref-zone"))
  assert.ok(zone, "references dropzone")
  assert.equal(typeof zone.props.onDrop, "function", "drop handler")
  assert.equal(typeof zone.props.onDragOver, "function", "dragover handler")
  assert.equal(types.some((item) => item.type === "select"), false, "no native selects")
  const style = moduleExports.__test.STYLE
  assert.match(style, /\.is-page \{[^}]*overflow: hidden;/s, "page does not scroll")
  assert.match(style, /\.is-history-scroll \{[^}]*overflow-x: auto;/s, "history scrolls horizontally")
  assert.match(style, /\.is-canvas-grid \{[^}]*grid-template-columns: repeat\(2,/s, "vibe canvas is 2x2")
  assert.match(style, /\.is-prompt-box textarea \{[^}]*max-height: 25vh;[^}]*resize: none(?: !important)?;/s, "prompt is capped and not user-resizable")
  assert.match(style, /\.is-ref-zone \{[^}]*border: 1px dashed/s, "dashed reference dropzone")
  assert.match(style, /\.is-history-card:hover \.is-history-actions/s, "history actions appear on hover")
  assert.ok(types.some((item) => String(item.props.className ?? "").includes("is-ref-add")), "file-picker tile in references")
})

test("history card is clean at rest, draggable and exposes hover actions", () => {
  const t = moduleExports.__test.TEXT.en
  const entry = {
    id: "a.png",
    file: "/tmp/images/a.png",
    prompt: "A cat in a hat",
    model: "qwen-image-3.0",
    size: "1024x1024",
    createdAt: "2026-11-08T12:00:00Z",
  }
  const { types, strings } = collect(
    moduleExports.__test.HistoryCard({
      entry,
      cwd: "/tmp",
      t,
      lang: "en",
      confirming: false,
      inRefs: false,
      onOpen: () => {},
      onCopy: () => {},
      onHide: () => {},
      onDelete: () => {},
      onReveal: () => {},
      onReference: () => {},
    }),
  )
  const card = types.find((item) => String(item.props.className ?? "").startsWith("is-history-card"))
  assert.ok(card, "history card")
  assert.equal(card.props.draggable, true)
  const transfer = { setData: (type, value) => { transfer.data[type] = value; }, data: {}, effectAllowed: "" }
  card.props.onDragStart({ dataTransfer: transfer })
  assert.equal(transfer.data["application/x-dsh-q-image-studio-id"], "a.png")
  const plus = types.find((item) => item.type === "button" && String(item.props.className ?? "").includes("is-history-add"))
  assert.ok(plus, "round add-to-references button")
  assert.equal(plus.props.disabled, false)
  assert.ok(strings.includes("A cat in a hat"), "prompt label")
  const labels = types.filter((item) => item.type === "button").map((item) => item.props.title).filter(Boolean)
  for (const label of [t.copyImage, t.reveal, t.hide, t.delete]) assert.ok(labels.includes(label), `action ${label}`)
})

test("lightbox renders index metadata, transparent state and actions", () => {
  const t = moduleExports.__test.TEXT.en
  const entry = {
    id: "2026.png",
    prompt: "original prompt",
    finalPrompt: "improved final prompt",
    model: "qwen-image-3.0",
    size: "1024x576",
    seed: 42,
    transparent: true,
    promptExtend: false,
    file: "/Users/me/Images/Q-Image-Studio/2026.png",
    createdAt: "2026-11-08T20:08:00+03:00",
  }
  const seen = { use: 0, reference: 0 }
  const tree = moduleExports.__test.Lightbox({
    entry,
    cwd: "/tmp",
    t,
    lang: "en",
    animations: false,
    inRefs: false,
    onClose: () => {},
    onNavigate: () => {},
    onUse: () => { seen.use += 1 },
    onReference: () => { seen.reference += 1 },
    onReveal: () => {},
    onRemove: () => {},
  })
  const { types, strings } = collect(tree)
  const shell = types.find((item) => String(item.props.className ?? "").startsWith("is-lightbox"))
  assert.ok(String(shell.props.className).includes("is-static"), "animations off disables overlay animation")
  const media = types.find((item) => String(item.props.className ?? "").includes("is-lb-media"))
  assert.ok(String(media.props.className).includes("is-transparent"), "transparent PNG checkerboard")
  for (const value of ["1024 × 576", "589,824 px", "42", "qwen-image-3.0", "original prompt", "improved final prompt", "~/Images/Q-Image-Studio/2026.png"]) {
    assert.ok(strings.some((text) => String(text).includes(value)), `shows ${value}`)
  }
  const buttons = types.filter((item) => item.type === "button")
  buttons.find((item) => item.props.title === t.useParameters).props.onClick()
  assert.equal(seen.use, 1)
  buttons.find((item) => item.props.title === t.toReferences).props.onClick()
  assert.equal(seen.reference, 1)
})

test("lightbox shows a missing-file state with remove action", () => {
  const t = moduleExports.__test.TEXT.en
  let removed = 0
  const { strings, types } = collect(
    moduleExports.__test.Lightbox({
      entry: { id: "gone.png", prompt: "gone", file: "/tmp/gone.png" },
      cwd: "/tmp",
      t,
      lang: "en",
      initialMissing: true,
      onClose: () => {},
      onNavigate: () => {},
      onUse: () => {},
      onReference: () => {},
      onReveal: () => {},
      onRemove: () => { removed += 1 },
      returnFocusRef: { current: null },
    }),
  )
  assert.ok(strings.includes(t.fileMissing))
  const button = types.find((item) => item.type === "button" && item.props.title === t.removeFromHistory)
  assert.ok(button, "remove from history button")
  button.props.onClick()
  assert.equal(removed, 1)
})

test("lightbox helpers format sizes, paths and repeat state", () => {
  const t = moduleExports.__test.TEXT.ru
  assert.deepEqual(moduleExports.__test.entryDimensions({ size: "1024x576" }), {
    width: 1024,
    height: 576,
    pixels: 589824,
  })
  assert.equal(moduleExports.__test.entryDimensions({ size: "auto" }), null)
  assert.equal(moduleExports.__test.displayPath("/Users/alice/Images/x.png"), "~/Images/x.png")
  assert.equal(moduleExports.__test.displayPath("images/x.png"), "images/x.png")
  assert.equal(moduleExports.__test.extendLabel({ transparent: true }, t), t.extendForTransparency)
  assert.equal(moduleExports.__test.extendLabel({ promptExtend: false }, t), t.extendOffShort)
  assert.equal(moduleExports.__test.extendLabel({ promptExtend: true }, t), t.extendOn)
})

test("history card click opens the lightbox but buttons keep their action", () => {
  const t = moduleExports.__test.TEXT.en
  let opened = 0
  const tree = moduleExports.__test.HistoryCard({
    entry: { id: "a.png", prompt: "A cat", file: "/tmp/a.png" },
    cwd: "/tmp",
    t,
    lang: "en",
    confirming: false,
    inRefs: false,
    onOpen: () => { opened += 1 },
    onCopy: () => {},
    onHide: () => {},
    onDelete: () => {},
    onReveal: () => {},
    onReference: () => {},
  })
  const { types } = collect(tree)
  const card = types.find((item) => String(item.props.className ?? "").startsWith("is-history-card"))
  card.props.onClick({ target: { closest: () => null } })
  assert.equal(opened, 1)
  card.props.onClick({ target: { closest: () => ({}) } })
  assert.equal(opened, 1, "action buttons do not open the lightbox")
})

test("lightbox styles cover overlay, layout, primary action and reduced motion", () => {
  const style = moduleExports.__test.STYLE
  assert.match(style, /\.is-lightbox \{[^}]*position: fixed;[^}]*inset: 0;[^}]*background: rgba\(0, 0, 0, \.72\);/s)
  assert.match(style, /backdrop-filter: blur\(3px\)/)
  assert.match(style, /\.is-lb-card \{[^}]*grid-template-columns: minmax\(0, 1fr\) 390px;/s)
  assert.match(style, /\.is-lb-card \{[^}]*height: min\(92vh, 820px\);/s)
  assert.match(style, /\.is-lb-actions \.is-primary \{[^}]*background: var\(--qis-accent\);/s)
  assert.match(style, /animation: is-lb-card-in 180ms/)
  assert.match(style, /\.is-lightbox\.is-static,[^{]*\{ animation: none;/s)
  assert.match(style, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.is-lightbox,\s*\.is-lb-card/)
})

test("canvas slot count comes only from the last Generate click", () => {
  const { canvasSlotCount } = moduleExports.__test
  assert.equal(canvasSlotCount({ busy: true, requested: 4, ids: [] }), 4)
  assert.equal(canvasSlotCount({ busy: true, requested: 1, ids: [] }), 1)
  assert.equal(canvasSlotCount({ busy: false, requested: 4, ids: ["a", "b"] }), 2)
  assert.equal(canvasSlotCount({ busy: false, requested: 1, ids: [] }), 0)
})

test("mode buttons never fetch and the saved canvas survives a remount", () => {
  const { StudioPanel, TEXT, studioMemory } = moduleExports.__test
  const saved = {
    ids: studioMemory.ids.slice(), entries: studioMemory.entries.slice(),
    requested: studioMemory.requested, removed: studioMemory.removed.slice(),
    busy: studioMemory.busy, progress: { ...studioMemory.progress },
    mode: studioMemory.mode, saveDir: studioMemory.saveDir,
  }
  try {
    const scope = {
      getSnapshot: () => ({ value: { language: "ru", saveDir: "/tmp/images", animations: true } }),
      subscribe: () => () => {},
      set: async () => true,
    }
    const page = collect(StudioPanel({ scope, close: () => {} }))
    const before = globalThis.fetch
    let calls = 0
    globalThis.fetch = () => { calls++; return Promise.reject(new Error("no network")) }
    const vibe = page.types.find((item) => item.type === "button" && item.props.className?.includes("is-mode-btn") && String(item.children ?? "").includes("Vibe"))
    // walk() expands components and drops their children, so find by aria-pressed + class list.
    const modeButtons = page.types.filter((item) => item.type === "button" && String(item.props.className ?? "").includes("is-mode-btn"))
    assert.equal(modeButtons.length, 2)
    modeButtons[1].props.onClick()
    assert.equal(calls, 0, "mode is panel state, not a network request")
    assert.equal(studioMemory.mode, "vibe")
    globalThis.fetch = before
    assert.equal(vibe, undefined)

    const first = { id: "a", size: "1024x576", model: "m", seed: 1, prompt: "one", createdAt: "2026-11-08T10:00:00" }
    const second = { id: "b", size: "1024x576", model: "m", seed: 2, prompt: "two", createdAt: "2026-11-08T10:00:01" }
    studioMemory.ids = []
    studioMemory.requested = 0
    studioMemory.entries = [first, second]
    const firstOpen = collect(StudioPanel({ scope, close: () => {} }))
    assert.equal(firstOpen.types.filter((item) => item.props.className === "is-canvas-cell").length, 0, "history alone does not fill the canvas")
    studioMemory.ids = ["a", "b"]
    studioMemory.requested = 2
    studioMemory.removed = []
    studioMemory.busy = false
    studioMemory.entries = [first, second]
    studioMemory.mode = "vibe"
    const restored = collect(StudioPanel({ scope, close: () => {} }))
    assert.equal(restored.types.filter((item) => item.props.className === "is-canvas-cell").length, 2, "last result is restored")
    const actions = restored.types.filter((item) => item.props.className === "is-tile-actions")
    assert.equal(actions.length, 2, "each tile owns its action row")

    studioMemory.removed = ["b"]
    studioMemory.entries = [first]
    const afterDelete = collect(StudioPanel({ scope, close: () => {} }))
    assert.ok(afterDelete.strings.includes(TEXT.ru.deletedTile), "deleted slot keeps a stub")
    assert.equal(afterDelete.types.filter((item) => item.props.className === "is-canvas-cell").length, 1)
    assert.equal(afterDelete.types.filter((item) => item.props.className === "is-tile-actions").length, 1)
  } finally {
    globalThis.fetch = globalThis.fetch ?? (async () => ({ ok: false }))
    Object.assign(studioMemory, saved)
    studioMemory.entries = saved.entries
  }
})

test("reference files fall back to extensions and size limits", () => {
  const { isImageFile, imageMediaType } = moduleExports.__test
  assert.equal(isImageFile({ name: "cat.PNG", type: "" }), true)
  assert.equal(isImageFile({ name: "cat.webp", type: "application/octet-stream" }), true)
  assert.equal(isImageFile({ name: "notes.txt", type: "" }), false)
  assert.equal(imageMediaType({ name: "cat.JPG", type: "" }), "image/jpeg")
  assert.equal(imageMediaType({ name: "cat.gif", type: "image/gif" }), "image/gif")
})

test("sidebar glyph uses the packaged plugin icon at the requested size", () => {
  const { SidebarGlyph } = moduleExports.__test
  const small = SidebarGlyph({ size: 20 })
  assert.equal(small.type, "span")
  assert.equal(small.props.className, "is-k8-plate")
  assert.deepEqual(small.props.style, { width: 20, height: 20 })
  assert.equal(small.children[0].type, "img")
  assert.equal(small.children[0].props.src, "/plugins/dsh-q-image-studio/icon")
  assert.equal(small.children[0].props.width, 20)
  assert.equal(small.children[0].props.height, 20)
  const bare = SidebarGlyph({ size: 32, plain: true })
  assert.equal(bare.type, "img")
  assert.equal(bare.props.width, 32)
  const page = moduleExports.__test.StudioPanel({ scope: { getSnapshot: () => ({ value: { language: "en" } }), subscribe: () => () => {} }, close: () => {} })
  const { types } = collect(page)
  const brand = types.find((item) => item.props.className === "is-brand-mark")
  assert.ok(brand)
})

test("reference file issues cover extension fallback and oversized files", () => {
  const { imageFileIssue } = moduleExports.__test
  assert.equal(imageFileIssue({ name: "cat.png", type: "", size: 10 }, 100), "")
  assert.equal(imageFileIssue({ name: "notes.txt", type: "text/plain", size: 10 }, 100), "bad")
  assert.equal(imageFileIssue({ name: "big.jpg", type: "image/jpeg", size: 101 }, 100), "large")
})

test("only the four supported image formats pass the client filter", () => {
  const { isImageFile } = moduleExports.__test
  assert.equal(isImageFile({ name: "x.svg", type: "image/svg+xml" }), false)
  assert.equal(isImageFile({ name: "x.tiff", type: "image/tiff" }), false)
  assert.equal(isImageFile({ name: "x.webp", type: "" }), true)
})


test("neon ring is thin, violet-to-cyan, and dots are small", () => {
  const { STYLE, entryAspect } = moduleExports.__test
  assert.match(STYLE, /\.is-page\.is-animating \.is-generate::after \{[^}]*inset: -3px; padding: 2px;/s)
  assert.match(STYLE, /\.is-page\.is-animating \.is-generate::after \{[^}]*is-neon-spin 2\.8s linear infinite;/s)
  assert.match(STYLE, /\.is-dots span \{[^}]*width: 5px; height: 5px;/s)
  assert.match(STYLE, /\.is-dots span \{[^}]*linear-gradient\(135deg,/s)
  assert.match(STYLE, /\.is-canvas-frame \{[^}]*aspect-ratio: var\(--ar, 1\);/s)
  assert.match(STYLE, /\.is-tile-actions \{[^}]*right: 8px; bottom: 8px;/s)
  assert.match(STYLE, /\.is-tile-actions \{[^}]*opacity: 0;/s)
  assert.match(STYLE, /\.is-page\.is-no-motion \.is-generate\[data-busy="true"\]::after \{[^}]*linear-gradient\(120deg,/s)
  assert.match(STYLE, /\.is-no-motion \.is-generate::after[^}]*\{[^}]*animation: none;/s)
  assert.ok(entryAspect({ size: "1024x576" }) > 1.7)
  assert.equal(entryAspect({ size: "bad" }), 1)
})

test("deleted canvas tiles have no loading dots", () => {
  const { StudioPanel, studioMemory } = moduleExports.__test
  const scope = { getSnapshot: () => ({ value: { language: "en", animations: true, saveDir: "/tmp/images" } }), subscribe: () => () => {}, set: async () => true }
  const entry = { id: "gone", size: "1024x576", model: "m", seed: 1, prompt: "x", createdAt: "2026-11-08T10:00:00" }
  studioMemory.ids = ["gone"]
  studioMemory.entries = []
  studioMemory.requested = 2
  studioMemory.removed = ["gone"]
  studioMemory.busy = false
  const tree = collect(StudioPanel({ scope, close: () => {} }))
  const removed = tree.types.find((item) => item.props?.className === "is-canvas-tile is-removed")
  assert.ok(removed, "removed stub is rendered")
  assert.ok(!tree.types.some((item) => item.props?.className === "is-dots"), "no dots on deleted tile")
})

test("provider failures expose status, code, and message; model access is distinct", () => {
  const { parseProviderFailure, modelIssueFromFailure, describeFailure, withUnavailableModel, modelOptionLabel } = moduleExports.__test
  const copy = { ...moduleExports.__test.TEXT.ru }
  const quota = "поставщик ответил HTTP 403 AllocationQuota.FreeTierOnly: The free quota has been exhausted"
  assert.deepEqual(parseProviderFailure(quota), {
    raw: quota,
    status: 403,
    code: "AllocationQuota.FreeTierOnly",
    detail: "The free quota has been exhausted",
  })
  assert.equal(modelIssueFromFailure(quota), true)
  assert.equal(modelIssueFromFailure("поставщик ответил HTTP 404: model not found"), true)
  assert.equal(modelIssueFromFailure("поставщик ответил HTTP 401 InvalidApiKey: Invalid API-key provided"), false)
  assert.equal(modelIssueFromFailure("поставщик ответил HTTP 401 Model.AccessDenied: denied"), true)
  assert.match(describeFailure(quota, copy), /Нет доступа к модели\. HTTP 403 · AllocationQuota\.FreeTierOnly — The free quota/)
  assert.match(
    describeFailure("поставщик ответил HTTP 401 InvalidApiKey: Invalid API-key provided", copy),
    /Ключ отклонён\. HTTP 401 · InvalidApiKey — Invalid API-key provided/,
  )
  assert.equal(describeFailure("HTTP 401", copy), "Ключ отклонён. HTTP 401")
  assert.deepEqual(withUnavailableModel([], "qwen-image-2.1-pro", true), ["qwen-image-2.1-pro"])
  assert.deepEqual(withUnavailableModel(["qwen-image-2.1-pro"], "qwen-image-2.1-pro", true), ["qwen-image-2.1-pro"])
  assert.deepEqual(withUnavailableModel(["qwen-image-2.1-pro"], "qwen-image-2.1-pro", false), [])
  assert.equal(modelOptionLabel("qwen-image-2.1-pro", ["qwen-image-2.1-pro"], copy), "qwen-image-2.1-pro — недоступна")
  assert.equal(modelOptionLabel("qwen-image-3.0", ["qwen-image-2.1-pro"], copy), "qwen-image-3.0")
})

test("verified settings list shows the unavailable-model suffix", () => {
  const profile = {
    id: "p1", label: "DashScope", baseURL: "https://dashscope-intl.aliyuncs.com",
    model: "qwen-image-2.1-pro", apiKeyRef: "K", verifiedAt: "2026-11-08T10:00:00.000Z",
    models: ["qwen-image-2.1-pro", "qwen-image-3.0"], unavailableModels: ["qwen-image-2.1-pro"],
  }
  const scope = {
    getSnapshot: () => ({ value: { language: "ru", saveDir: "/tmp/images", providers: [profile], activeProviderId: "p1" } }),
    subscribe: () => () => {},
    set: async () => true,
  }
  const tree = collect(moduleExports.__test.SettingsCard({ scope }))
  assert.ok(
    tree.strings.includes("qwen-image-2.1-pro — недоступна"),
    "selected unavailable model carries the suffix",
  )
})
