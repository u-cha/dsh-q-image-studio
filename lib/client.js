/**
 * dsh-q-image-studio — browser half.
 *
 * Two surfaces, deliberately split:
 *  - `plugins.bundle.config` — connections only: profiles with an editable
 *    name, Base URL, model and a vault-backed key. No prompt, size or run
 *    controls live here.
 *  - `main` + `sidebar.panellist` — the studio: prompt, model, size, seed,
 *    references and results. Values are per-run request parameters and are
 *    never written back to the global config.
 *
 * The module runs from the Harness browser module table: React is required,
 * not bundled.
 */

window.__ModuleLoader__.load({
  id: "@u-cha/dsh-q-image-studio",
  factory(require) {
    const React = require("react")
    const h = React.createElement

    const ROUTES = {
      keyStatus: "/plugins/dsh-q-image-studio/key-status",
      saveKey: "/plugins/dsh-q-image-studio/save-key",
      clearKey: "/plugins/dsh-q-image-studio/clear-key",
      testConnection: "/plugins/dsh-q-image-studio/test-connection",
      listModels: "/plugins/dsh-q-image-studio/list-models",
      generate: "/plugins/dsh-q-image-studio/generate",
      listGallery: "/plugins/dsh-q-image-studio/list-gallery",
      deleteImage: "/plugins/dsh-q-image-studio/delete-image",
      reveal: "/plugins/dsh-q-image-studio/reveal",
      open: "/plugins/dsh-q-image-studio/open",
      copy: "/plugins/dsh-q-image-studio/copy",
      pickFolder: "/plugins/dsh-q-image-studio/pick-folder",
      file: "/plugins/dsh-q-image-studio/file",
    }
    const SIDEBAR_ID = "dsh-q-image-studio"
    /**
     * `plugins.bundle.config` is a keyed slot whose keys are the bundle's
     * package names — the plugins page dispatches the package name, not the
     * loader entry id. Registering under the entry id leaves the card
     * unmounted (only the bundle description is rendered).
     */
    const CONFIG_SLOT_KEY = "@u-cha/dsh-q-image-studio"
    const LONG_SIDES = [768, 1024, 1536, 2048]
    const ASPECTS = ["1:1", "4:3", "3:2", "16:9", "9:16", "2:3", "3:4"]
    const SIZE_MODES = ["auto", "preset", "manual"]
    const MANUAL_MIN = 512
    const MANUAL_MAX = 2048
    const MANUAL_STEP = 32
    const MAX_AREA = 2_250_000
    const MAX_RATIO = 10
    const MIN_SIDE = 384
    const MAX_SEED = 2_147_483_647
    const TRANSPARENT_PREFIX = "This is an RGBA image with transparency."
    const TRANSPARENT_SUFFIX = "The image has alpha channel and the background is transparent."
    const VIBE_COUNT = 4
    /**
     * The studio page can be unmounted when the user visits another DSH page.
     * React state dies with it, so the last canvas result lives here as well.
     * It is deliberately module scoped: only the last "Generate" click owns it.
     */
    const studioMemory = {
      ids: [], entries: [], requested: 0, removed: [], busy: false,
      progress: { done: 0, total: 0 }, mode: "exact", saveDir: "", listeners: new Set(),
    }
    function studioEmit() {
      for (const listener of studioMemory.listeners) {
        try { listener() } catch { /* one broken subscriber must not stop the others */ }
      }
    }
    function studioRememberEntries(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return
      const merged = [...studioMemory.entries]
      for (const entry of entries) {
        const at = merged.findIndex((row) => row.id === entry.id)
        if (at >= 0) merged[at] = entry
        else merged.push(entry)
      }
      studioMemory.entries = merged
    }
    /** Only an explicit click decides the number of canvas slots. */
    function canvasSlotCount({ busy, requested, ids }) {
      return busy ? Math.max(0, requested) : ids.length
    }

    function round32(value) {
      return Math.round(Number(value) / MANUAL_STEP) * MANUAL_STEP
    }

    /** Exact transparent-background wrapper used for both UI preview and request. */
    function transparentPromptText(prompt) {
      return `${TRANSPARENT_PREFIX} ${String(prompt ?? "").trim()}. ${TRANSPARENT_SUFFIX}`
    }

    /** Preset geometry: fixed long side, rounded short side; invalid stays visible. */
    function presetSize(longSide, aspect) {
      const [left, right] = String(aspect).split(":").map(Number)
      const long = Number(longSide)
      const bigger = Math.max(left, right)
      const smaller = Math.min(left, right)
      const short = round32((long * smaller) / bigger)
      const width = left >= right ? long : short
      const height = left >= right ? short : long
      const pixels = width * height
      const minLong = Math.ceil((MIN_SIDE * bigger) / smaller)
      let reason = ""
      if (short < MIN_SIDE) reason = `минимум ${minLong} px для ${aspect}`
      else if (long > MANUAL_MAX) reason = `максимум ${MANUAL_MAX} px`
      return { width, height, size: `${width}x${height}`, pixels, valid: reason.length === 0, reason, highTariff: pixels > MAX_AREA }
    }

    function manualSize(width, height) {
      const w = Number(width)
      const h = Number(height)
      const size = `${w}x${h}`
      let reason = ""
      if (!Number.isInteger(w) || !Number.isInteger(h) || w % MANUAL_STEP !== 0 || h % MANUAL_STEP !== 0) {
        reason = `шаг ${MANUAL_STEP} px`
      } else if (w < MANUAL_MIN || h < MANUAL_MIN || w > MANUAL_MAX || h > MANUAL_MAX) {
        reason = `${MANUAL_MIN}…${MANUAL_MAX} px`
      } else if (w * h > MAX_AREA) {
        reason = `площадь больше ${MAX_AREA.toLocaleString("ru-RU")} px`
      } else if (Math.max(w, h) / Math.min(w, h) > MAX_RATIO) {
        reason = `соотношение больше ${MAX_RATIO}:1`
      }
      return { width: w, height: h, size, pixels: w * h, valid: reason.length === 0, reason }
    }

    function parseSeed(value) {
      const text = String(value ?? "").trim()
      if (!/^\d+$/.test(text)) return { ok: false, reason: "целое число" }
      const number = Number(text)
      if (!Number.isSafeInteger(number) || number < 0 || number > MAX_SEED) {
        return { ok: false, reason: `0…${MAX_SEED}` }
      }
      return { ok: true, value: number }
    }

    function randomSeed() {
      const crypto = globalThis.crypto
      if (crypto?.getRandomValues) {
        const buffer = new Uint32Array(1)
        crypto.getRandomValues(buffer)
        return buffer[0] % (MAX_SEED + 1)
      }
      return Math.floor(Math.random() * (MAX_SEED + 1))
    }

    function formatPixels(value, lang = "ru") {
      return Number(value).toLocaleString(lang === "en" ? "en-US" : "ru-RU")
    }

    const GUIDE_URL =
      "https://github.com/sceneworks/sceneworks/blob/a1d95e2c43eef4a34a3fe5bf420bb2cc2abe181f/apps/web/public/prompt-guides/qwen-image.md"

    // Compact English-only digest of the linked Qwen Image prompt guide.
    const GUIDE_SECTIONS = [
      {
        title: "Subject",
        body: "Count, age or type, action, pose, clothing, expression and distinguishing traits.",
        examples: [
          "Good: a ceramic fox figurine wearing a tiny raincoat, standing beside a puddle.",
        ],
      },
      {
        title: "Details",
        body: "Concrete environment and object details. For text, quote the exact words and describe typography, size and placement.",
      },
      {
        title: "Style",
        examples: [
          "realistic photography",
          "watercolor",
          "3D cartoon",
          "ink painting",
          "post-apocalyptic",
          "surreal",
          "flat editorial poster",
        ],
      },
      {
        title: "Camera",
        examples: [
          "extreme close-up",
          "medium shot",
          "long shot",
          "eye-level perspective",
          "bird's-eye view",
          "low angle",
          "macro lens",
          "telephoto lens",
        ],
      },
      {
        title: "Lighting",
        body: "Add mood only when it maps to visible details.",
        examples: [
          "natural morning light",
          "soft backlight",
          "neon light after rain",
          "ambient lantern glow",
        ],
      },
      {
        title: "Negative prompt",
        examples: [
          "low resolution",
          "blurry text",
          "distorted hands",
          "malformed fingers",
          "chaotic composition",
          "warped lettering",
        ],
      },
      {
        title: "Example",
        examples: [
          'A hand-drawn poster of three puppies playing with a blue ball on lush green grass. The top headline reads "COME PLAY BALL!" in bold rounded blue letters. A smaller subtitle below reads "Show Off Your Skills" in green. Fresh greens and sky blues, cheerful childlike illustration, centered poster layout, soft sunlight, decorative birds and stars.',
        ],
      },
    ]

    function guidePlainText() {
      return [
        "Qwen Image Prompt Guide",
        "Formula: subject + setting + style + camera + atmosphere + detail modifiers. A shorter subject + setting + style also works.",
        ...GUIDE_SECTIONS.map((section) =>
          `${section.title}: ${[section.body, ...(section.examples ?? [])].filter(Boolean).join(" ")}`,
        ),
        `Full guide: ${GUIDE_URL}`,
      ].join("\n\n")
    }

    async function copyText(value) {
      const text = String(value ?? "")
      if (text.length === 0) return false
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    function generateLabels(mode, t) {
      const vibe = mode === "vibe"
      return { full: vibe ? t.generateFour : t.generateOne, short: vibe ? t.generateFourShort : t.generateOneShort }
    }

    /** Copy an image through the Host; report success only after {ok:true}. */
    async function copyImageEntry({ entry, copy, flash, fail, t }) {
      try {
        const result = await copy(entry)
        if (!result?.ok) throw new Error(result?.error || t.failed)
        flash(t.copied)
        return true
      } catch (failure) {
        fail(failure?.message ?? t.failed)
        return false
      }
    }

    function dayLabel(value, lang, now = new Date()) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return "—"
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const days = Math.round((today - start) / 86_400_000)
      if (days === 0) return lang === "ru" ? "Сегодня" : "Today"
      if (days === 1) return lang === "ru" ? "Вчера" : "Yesterday"
      return date.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", {
        day: "numeric",
        month: "long",
        year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
      })
    }

    /** Newest-first entries grouped by calendar day, preserving order. */
    function groupByDay(entries, lang, now = new Date()) {
      const groups = []
      for (const entry of entries ?? []) {
        const label = dayLabel(entry.createdAt, lang, now)
        const last = groups[groups.length - 1]
        if (last && last.label === label) last.entries.push(entry)
        else groups.push({ label, entries: [entry] })
      }
      return groups
    }
    const PLACEHOLDER_BASE_URL = "https://dashscope-intl.aliyuncs.com"
    const PLACEHOLDER_MODEL = "qwen-image-2.0"

    const TEXT = {
      ru: {
        title: "Q Image Studio",
        profile: "Профиль",
        profileHint: "поставщик и ключ",
        add: "Добавить",
        remove: "Удалить",
        name: "Название",
        nameProfile: "Название профиля",
        namePlaceholder: "Мой профиль",
        nameHint: "имя видно только вам",
        autoSaveHint: "Изменения сохраняются автоматически",
        saved: "Сохранено",
        deleteProfile: "Удалить профиль",
        deleteConfirm: "Удалить?",
        profileDeleted: "Профиль удалён",
        clearKeyFailed: "Не удалось очистить ключ",
        baseUrl: "Базовый URL",
        model: "Модель",
        key: "Ключ",
        keySaved: "Ключ сохранён",
        keyHidden: "••••••••",
        verifyInSettings: "Сначала проверьте подключение в настройках",
        noKey: "Ключа нет",
        check: "Проверить",
        forget: "Забыть ключ",
        connected: "Подключено",
        models: "моделей",
        chooseModel: "Выберите модель",
        checking: "Проверяю…",
        prompt: "Запрос",
        promptPlaceholder: "Кот в шляпе, акварель",
        size: "Размер",
        modeExact: "Точно",
        modeVibe: "Vibe Create",
        vibeCount: "4 генерации — дороже, чем одна",
        vibeProgress: "Готово {done} из {total}",
        sizeMode: "Режим размера",
        sizeAuto: "Авто",
        sizeAutoHint: "размер не передаётся — его выберет модель",
        sizePreset: "Пресет",
        sizeManual: "Вручную",
        longSide: "Длинная сторона",
        aspect: "Соотношение",
        width: "Ширина",
        height: "Высота",
        tariffBase: "базовый тариф",
        tariffHigh: "повышенный тариф",
        seed: "Сид",
        seedRandom: "Случайный",
        seedInvalid: "Сид — целое число от 0 до 2 147 483 647.",
        promptExtend: "Улучшение промпта",
        extendOff: "улучшение промпта отключено для точного повтора",
        extendTransparent: "улучшение промпта отключено для прозрачного фона",
        extendReturn: "вернуть",
        transparent: "Прозрачный фон",
        alphaWarning: "Картинка пришла без прозрачных пикселей.",
        alphaNoChannel: "Модель вернула изображение без прозрачности; попробуйте qwen-image-2.1-pro.",
        details: "Детали",
        generateOne: "Генерировать 1 картинку",
        generateFour: "Генерировать 4 картинки",
        generateOneShort: "Генерировать · 1",
        generateFourShort: "Генерировать · 4",
        generating: "Генерирую…",
        close: "Закрыть",
        references: "Референсы",
        addFiles: "Файлы",
        results: "Результаты",
        result: "Результат",
        history: "История",
        historyHint: "наведите на карточку — появятся действия",
        lastGeneration: "Последняя генерация",
        canvasEmpty: "Здесь появится результат",
        deletedTile: "Удалено",
        dragRefs: "Перетащите или выберите файл",
        empty: "Пока нет картинок — сгенерируйте первую.",
        allHidden: "Все карточки скрыты.",
        hidden: "Скрыто",
        showHidden: "Показать снова",
        reveal: "Показать в Finder",
        copy: "Копировать",
        copyImage: "Копировать картинку",
        copied: "Скопировано",
        openViewer: "Открыть в просмотрщике",
        hide: "Скрыть",
        delete: "Удалить",
        confirmDelete: "Нажмите «Удалить» ещё раз, чтобы стереть файл с диска.",
        revealed: "Открыто в Finder.",
        removeRef: "Убрать",
        saveDir: "Папка сохранения",
        saveDirHint: "абсолютный путь; меняется только кнопкой «Выбрать…»",
        confirmMigration: "Перенести {count} картинок?",
        saveDirInvalid: "Нужен абсолютный путь — выберите папку кнопкой «Выбрать…».",
        saveDirEmpty: "Укажите путь сохранения.",
        pickFolder: "Выбрать…",
        picking: "Открываю…",
        needPrompt: "Опишите, что нарисовать.",
        failed: "Не получилось",
        badFile: "Нужна картинка: PNG, JPG, WebP или GIF.",
        fileTooLarge: (mb) => `Файл больше ${mb} МБ.`,
        limit: "Максимум 10 референсов.",
        noProvider: "Добавьте профиль в настройках плагина.",
        errorTitle: "Не удалось",
        error404: "Модель {model} недоступна.",
        errorAuth: "Ключ отклонён.",
        errorForbidden: "Нет доступа к модели.",
        errorRate: "Слишком много запросов.",
        modelUnavailable: "недоступна на этом ключе",
        modelUnavailableShort: "недоступна",
        errorNetwork: "Нет связи с поставщиком. Проверьте базовый URL и сеть.",
        errorKey: "Ключ не задан. Добавьте его в настройках плагина.",
        retry: "Повторить",
        language: "Язык",
        animations: "Анимации",
        modelDefault: "Модель по умолчанию",
        verifyFirst: "Сначала проверьте подключение.",
        enterManually: "ввести вручную",
        useList: "выбрать из списка",
        qwenWarning: "Это не Qwen: работа с другими моделями не гарантируется.",
        noModels: "Подключено, но моделей qwen-image-* не найдено.",
        errorNotFound: "Список моделей недоступен (HTTP 404). Проверьте базовый URL.",
        errorAddress: "Поставщик ответил ошибкой. Проверьте базовый URL.",
        settingsUnavailable: "Настройки ещё не готовы. Профили показаны только для чтения.",
        cardError: "Карточка настроек не открылась.",
        guide: "Гайд",
        guideFull: "Открыть полный гайд",
        guideRuHint:
          "Промпт лучше писать по-английски: терминология гайда (extreme close-up, macro lens, rim light) понятнее модели и переносится в другие модели без потерь. Сам гайд — без перевода.",
        useSettings: "Использовать те же настройки",
        develop: "Развивать",
        toReferences: "В референсы",
        inReferences: "в референсах",
        showMore: "Показать ещё",
        yes: "Да",
        no: "Нет",
        promptLabel: "Промпт",
        lightboxTitle: "Параметры генерации",
        originalPrompt: "Запрос",
        finalPrompt: "Итоговый промпт",
        copyShort: "копировать",
        promptExtendLabel: "Улучшение промпта",
        extendOn: "вкл",
        extendOffShort: "отключено для точного повтора",
        extendForTransparency: "отключено для прозрачного фона",
        fileLabel: "Файл",
        createdLabel: "Создано",
        useParameters: "Использовать параметры",
        copyPrompt: "Скопировать промпт",
        fileMissing: "Файл не найден на диске",
        removeFromHistory: "Убрать из истории",
        prevImage: "Предыдущая картинка",
        nextImage: "Следующая картинка",
      },
      en: {
        title: "Q Image Studio",
        profile: "Profile",
        profileHint: "provider and key",
        add: "Add",
        remove: "Remove",
        name: "Name",
        nameProfile: "Profile name",
        namePlaceholder: "My profile",
        nameHint: "only you see this name",
        autoSaveHint: "Changes are saved automatically",
        saved: "Saved",
        deleteProfile: "Delete profile",
        deleteConfirm: "Delete?",
        profileDeleted: "Profile deleted",
        clearKeyFailed: "Could not clear the key",
        baseUrl: "Base URL",
        model: "Model",
        key: "API key",
        keySaved: "Key saved",
        keyHidden: "••••••••",
        verifyInSettings: "Test the connection in settings first",
        noKey: "No key",
        check: "Test",
        forget: "Forget key",
        connected: "Connected",
        models: "models",
        chooseModel: "Choose a model",
        checking: "Checking…",
        prompt: "Prompt",
        promptPlaceholder: "A cat in a hat, watercolor",
        size: "Size",
        modeExact: "Precise",
        modeVibe: "Vibe Create",
        vibeCount: "4 generations — pricier than one",
        vibeProgress: "Done {done} of {total}",
        sizeMode: "Size mode",
        sizeAuto: "Auto",
        sizeAutoHint: "no size is sent — the model chooses it",
        sizePreset: "Preset",
        sizeManual: "Manual",
        longSide: "Long side",
        aspect: "Aspect ratio",
        width: "Width",
        height: "Height",
        tariffBase: "base rate",
        tariffHigh: "higher rate",
        seed: "Seed",
        seedRandom: "Random",
        seedInvalid: "Seed must be an integer from 0 to 2,147,483,647.",
        promptExtend: "Prompt enhancement",
        extendOff: "prompt enhancement is off for an exact repeat",
        extendTransparent: "prompt enhancement is off for transparency",
        extendReturn: "enable",
        transparent: "Transparent background",
        alphaWarning: "The image has no transparent pixels.",
        alphaNoChannel: "The model returned an image without transparency; try qwen-image-2.1-pro.",
        details: "Details",
        generateOne: "Generate 1 image",
        generateFour: "Generate 4 images",
        generateOneShort: "Generate · 1",
        generateFourShort: "Generate · 4",
        generating: "Generating…",
        close: "Close",
        references: "References",
        addFiles: "Files",
        results: "Results",
        result: "Result",
        history: "History",
        historyHint: "hover a card for actions",
        lastGeneration: "Latest generation",
        canvasEmpty: "Your result will appear here",
        deletedTile: "Deleted",
        dragRefs: "Drop or choose a file",
        empty: "No images yet — generate the first one.",
        allHidden: "All cards are hidden.",
        hidden: "Hidden",
        showHidden: "Show again",
        reveal: "Show in Finder",
        copy: "Copy",
        copyImage: "Copy image",
        copied: "Copied",
        openViewer: "Open in viewer",
        hide: "Hide",
        delete: "Delete",
        confirmDelete: "Click Delete again to remove the file from disk.",
        revealed: "Revealed in Finder.",
        removeRef: "Remove",
        saveDir: "Save folder",
        saveDirHint: "absolute path; changed only with the Choose… button",
        confirmMigration: "Move {count} images?",
        saveDirInvalid: "An absolute path is required — use the Choose… button.",
        saveDirEmpty: "Enter a save path.",
        pickFolder: "Choose…",
        picking: "Opening…",
        needPrompt: "Describe what to draw.",
        failed: "Failed",
        badFile: "Image required: PNG, JPG, WebP or GIF.",
        limit: "Up to 10 references.",
        noProvider: "Add a profile in the plugin settings.",
        errorTitle: "Request failed",
        error404: "Model {model} is unavailable.",
        errorAuth: "The key was rejected.",
        errorForbidden: "No access to this model.",
        errorRate: "Too many requests.",
        modelUnavailable: "unavailable on this key",
        modelUnavailableShort: "unavailable",
        errorNetwork: "Cannot reach the provider. Check the Base URL and network.",
        errorKey: "No key configured. Add one in plugin settings.",
        retry: "Retry",
        language: "Language",
        animations: "Animations",
        modelDefault: "Default model",
        verifyFirst: "Test the connection first.",
        enterManually: "enter manually",
        useList: "choose from list",
        qwenWarning: "This is not Qwen — other models are not guaranteed to work.",
        noModels: "Connected, but no qwen-image-* models were found.",
        errorNotFound: "The model list is unavailable (HTTP 404). Check the Base URL.",
        errorAddress: "The provider returned an error. Check the Base URL.",
        settingsUnavailable: "Settings are not ready yet. Profiles are shown read-only.",
        cardError: "The settings card failed to render.",
        guide: "Guide",
        guideFull: "Open full guide",
        guideRuHint: "English is recommended for prompts — the model understands the terminology better.",
        useSettings: "Use these settings",
        develop: "Develop",
        toReferences: "Add to references",
        inReferences: "in references",
        showMore: "Show more",
        yes: "Yes",
        no: "No",
        promptLabel: "Prompt",
        lightboxTitle: "Generation details",
        originalPrompt: "Prompt",
        finalPrompt: "Final prompt",
        copyShort: "copy",
        promptExtendLabel: "Prompt enhancement",
        extendOn: "on",
        extendOffShort: "disabled for an exact repeat",
        extendForTransparency: "disabled for a transparent background",
        fileLabel: "File",
        createdLabel: "Created",
        useParameters: "Use settings",
        copyPrompt: "Copy prompt",
        fileMissing: "File not found on disk",
        removeFromHistory: "Remove from history",
        prevImage: "Previous image",
        nextImage: "Next image",
      },
    }

    /** Plugin language lives in config, defaults to English. */
    function configLanguage(value) {
      return value === "ru" ? "ru" : "en"
    }

    function modelsLabel(count, lang) {
      const n = Math.abs(Number(count) || 0)
      if (lang === "en") return n === 1 ? "model" : "models"
      const mod10 = n % 10
      const mod100 = n % 100
      if (mod10 === 1 && mod100 !== 11) return "модель"
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "модели"
      return "моделей"
    }

    /** Human profile name: falls back to "Profile N" when the name is blank. */
    function profileName(row, index, t) {
      const label = String(row?.label ?? "").trim()
      return label || `${t.profile} ${index + 1}`
    }

    const DELETE_CONFIRM_MS = 3000

    /** First click arms (no deletion); a second click within the window deletes. No timer ever deletes. */
    function deleteClickDecision(armedAt, now = Date.now(), timeoutMs = DELETE_CONFIRM_MS) {
      return armedAt > 0 && now - armedAt <= timeoutMs ? "delete" : "arm"
    }

    /** Clear the vault key first; only then rewrite the provider list. A clear-key failure keeps the profile. */
    async function deleteProfileWithKey({ profile, providers, clear, write, errorText = "Could not clear the key" }) {
      const cleared = await clear(profile.id)
      if (cleared?.ok === false) throw new Error(cleared.error || errorText)
      const next = providers.filter((row) => row.id !== profile.id)
      const activeProviderId = next[0]?.id ?? ""
      await write({ providers: next, activeProviderId })
      return { providers: next, activeId: activeProviderId }
    }


    function text(language) {
      return TEXT[configLanguage(language)]
    }

    /** Map a Host verification failure code to a localized reason. */
    function describeConnectionFailure(result, copy) {
      const code = result?.code
      if (code === "auth") return copy.errorAuth
      if (code === "not-found") return copy.errorNotFound
      if (code === "network") return copy.errorNetwork
      if (code === "address") return copy.errorAddress
      if (code === "key-missing") return copy.errorKey
      return result?.message ?? copy.failed
    }

    /** Human file size for result cards. */
    function formatFileSize(bytes, lang = "ru") {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return ""
      const sep = lang === "ru" ? "," : "."
      const units = lang === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"]
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      const digits = unit === 0 || size >= 100 ? 0 : 1
      return `${size.toFixed(digits).replace(".", sep)} ${units[unit]}`
    }

    /** Split "поставщик ответил HTTP 403 CODE: message" into its parts. */
    function parseProviderFailure(message) {
      const raw = String(message ?? "").trim()
      const match = raw.match(/HTTP\s+(\d{3})(?:\s+([A-Za-z][A-Za-z0-9_.-]*))?(?:\s*(?::|—|-)\s*([\s\S]*))?$/)
      if (match === null) return { raw, status: 0, code: "", detail: "" }
      return {
        raw,
        status: Number(match[1]),
        code: match[2] ?? "",
        detail: String(match[3] ?? "").trim(),
      }
    }

    /** True when the provider says this model is not callable with this key. */
    function modelIssueFromFailure(message) {
      const failure = parseProviderFailure(message)
      if (failure.status === 0) return false
      if (failure.status === 404) return true
      if (failure.status === 403) return true
      if (failure.status === 401 && !/InvalidApiKey|invalid_api_key/i.test(failure.code)) {
        return /access|permission|model|quota|allocation/i.test(failure.code)
      }
      return false
    }

    /** Keep a model in the list but remember the provider refused it. */
    function withUnavailableModel(models, model, unavailable) {
      const list = Array.isArray(models) ? models.filter((name) => typeof name === "string") : []
      const marked = new Set(list)
      if (unavailable) marked.add(model)
      else marked.delete(model)
      return Array.from(marked)
    }

    /** Label one model; the suffix is visible in the dropdown, not hidden. */
    function modelOptionLabel(name, unavailableModels, copy) {
      const marked = Array.isArray(unavailableModels) && unavailableModels.includes(name)
      return marked ? `${name} — ${copy.modelUnavailableShort}` : name
    }

    /** Turn transport/provider failures into an actionable, localized reason. */
    function describeFailure(message, copy, model = "") {
      const raw = String(message ?? "").trim()
      if (raw.length === 0) return copy.failed
      if (/ключ не задан|no key configured/i.test(raw)) return copy.errorKey
      const failure = parseProviderFailure(raw)
      if (failure.status > 0) {
        const code = failure.code ? ` · ${failure.code}` : ""
        const detail = failure.detail ? ` — ${failure.detail}` : ""
        if (failure.status === 404) {
          const base = String(copy.error404)
            .replace("{model}", model.length > 0 ? `«${model}»` : "")
            .replace(/\s+/g, " ")
            .trim()
          return `${base} HTTP 404${code}${detail}`
        }
        if (failure.status === 403 || modelIssueFromFailure(raw)) {
          return `${copy.errorForbidden} HTTP ${failure.status}${code}${detail}`
        }
        if (failure.status === 401) {
          return `${copy.errorAuth} HTTP 401${code}${detail}`
        }
        if (failure.status === 429) return `${copy.errorRate} HTTP 429${detail}`
        return `HTTP ${failure.status}${code}${detail}`
      }
      if (/fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|timeout/i.test(raw)) return copy.errorNetwork
      return raw
    }

    /**
     * Ask the Host to validate a folder change. A non-empty destination is an
     * error; a non-empty source asks for confirmation and only a second call
     * with `migrate: true` moves the files and index.
     */
    async function changeSaveDir({ saveDir, migrate = false, confirm, post = postJson } = {}) {
      const first = await post(ROUTES.saveDir, { saveDir, migrate })
      if (first?.code === "confirm-migration") {
        const approved = typeof confirm === "function" ? confirm(first.count) : false
        if (!approved) return { ok: false, cancelled: true, count: first.count }
        return post(ROUTES.saveDir, { saveDir, migrate: true })
      }
      return first
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      const textBody = await response.text()
      let parsed
      try {
        parsed = textBody.length > 0 ? JSON.parse(textBody) : {}
      } catch {
        parsed = { ok: false, error: textBody.slice(0, 300) || `HTTP ${response.status}` }
      }
      if (!response.ok) throw new Error(parsed?.error || `HTTP ${response.status}`)
      return parsed
    }

    /** Empty profile draft: the user names the profile and fills the connection. */
    function newProfile(id) {
      return { id, label: "", baseURL: "", model: "", apiKeyRef: "" }
    }

    /** Request body for one studio run. Per-run parameters only — never config writes. */
    function buildPanelRequest(input) {
      const request = {
        providerId: input.providerId || undefined,
        prompt: String(input.prompt ?? ""),
        model: String(input.model ?? "").trim() || undefined,
        references: Array.isArray(input.references) ? input.references : [],
        transparent: input.transparent === true,
        promptExtend: input.promptExtend !== false,
      }
      const size = String(input.size ?? "").trim()
      if (size.length > 0) request.size = size
      if (Number.isInteger(input.seed)) request.seed = input.seed
      if (input.cwd) request.cwd = input.cwd
      return request
    }

    /**
     * Launch Vibe jobs concurrently. Each job settles independently: one
     * rejection never cancels the others, and every result is delivered as
     * soon as it is ready.
     */
    async function runVibe({ run, count = VIBE_COUNT, onResult, onProgress, onError }) {
      let done = 0
      let failed = 0
      const tasks = Array.from({ length: count }, (_, index) =>
        Promise.resolve()
          .then(() => run(index))
          .then((value) => onResult?.(value))
          .catch((error) => {
            failed += 1
            onError?.(error)
          })
          .finally(() => {
            done += 1
            onProgress?.(done, count)
          }),
      )
      await Promise.all(tasks)
      return { done, failed }
    }

    /** Transparency warning for one finished card, or "" when nothing to warn about. */
    function alphaWarningText(hit, copy) {
      if (!hit?.transparent || !hit.alphaChecked) return ""
      if (hit.hasAlpha === false) return copy.alphaNoChannel
      if (!hit.transparentPixels) return copy.alphaWarning
      return ""
    }

    /** Newest first, de-duplicated by gallery id; old runs stay visible. */
    function mergeResults(previous, incoming) {
      const seen = new Set()
      const merged = []
      for (const entry of [...(incoming ?? []), ...(previous ?? [])]) {
        if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue
        seen.add(entry.id)
        merged.push(entry)
      }
      return merged
    }

    function baseName(value) {
      return String(value ?? "").split(/[\\/]/).pop()
    }

    function fileUrl(cwd, id) {
      return `${ROUTES.file}?cwd=${encodeURIComponent(cwd || "")}&id=${encodeURIComponent(id)}`
    }

    /** Save directory must be absolute (`~` is expanded by the Host). */
    /** Base URL is Qwen only on an Alibaba DashScope host. */
    function isDashScopeUrl(value) {
      try {
        const host = new URL(String(value).trim()).hostname.toLowerCase()
        return host === "aliyuncs.com" || host.endsWith(".aliyuncs.com")
      } catch {
        return false
      }
    }

    function normalizeSaveDir(value) {
      const raw = String(value ?? "").trim().replace(/\\/g, "/")
      if (raw.length === 0) return { ok: false, error: "empty" }
      if (raw === "~" || raw.startsWith("~/")) return { ok: true, value: raw }
      if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return { ok: true, value: raw }
      return { ok: false, error: "relative" }
    }

    const DISMISSED_PREFIX = "dsh-q-image-studio:dismissed:"

    function dismissedKey(saveDir) {
      return `${DISMISSED_PREFIX}${String(saveDir ?? "")}`
    }

    function readDismissed(key, storage = globalThis.localStorage) {
      try {
        const parsed = JSON.parse(storage?.getItem(key) ?? "[]")
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []
      } catch {
        return []
      }
    }

    function writeDismissed(key, ids, storage = globalThis.localStorage) {
      try {
        storage?.setItem(key, JSON.stringify(ids))
      } catch {
        /* private mode or quota — hiding still works for this session */
      }
    }

    function formatDate(value, lang) {
      if (value === undefined || value === null || value === "") return "—"
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString(lang === "en" ? "en-US" : "ru-RU", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      } catch {
        return date.toISOString()
      }
    }

    function formatTime(value, lang) {
      if (value === undefined || value === null || value === "") return "—"
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return "—"
      try {
        return date.toLocaleTimeString(lang === "en" ? "en-US" : "ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        })
      } catch {
        return date.toISOString().slice(11, 16)
      }
    }

    /** Show the home prefix as ~/ in a portable way. */
    function displayPath(value) {
      const text = String(value ?? "")
      const match = /^\/Users\/[^/]+\//.exec(text)
      return match ? `~/${text.slice(match[0].length)}` : text
    }

    function entryAspect(entry) {
      const dims = entryDimensions(entry)
      if (!dims || !dims.height) return 1
      return Math.max(0.2, Math.min(5, dims.width / dims.height))
    }

    function entryDimensions(entry) {
      const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(entry?.size ?? ""))
      if (!match) return null
      const width = Number(match[1])
      const height = Number(match[2])
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null
      return { width, height, pixels: width * height }
    }

    function extendLabel(entry, t) {
      if (entry?.transparent) return t.extendForTransparency
      if (entry?.promptExtend === false) return t.extendOffShort
      return t.extendOn
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ""))
        reader.onerror = () => reject(new Error("не удалось прочитать файл"))
        reader.readAsDataURL(file)
      })
    }

    const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i
    const IMAGE_MEDIA = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }

    function isImageFile(file) {
      const type = String(file?.type ?? "")
      if (type === "image/png" || type === "image/jpeg" || type === "image/webp" || type === "image/gif") return true
      if (type.startsWith("image/")) return false
      return IMAGE_FILE_RE.test(String(file?.name ?? ""))
    }

    function imageFileIssue(file, maxBytes) {
      if (!isImageFile(file)) return "bad"
      if (Number(file?.size) > Number(maxBytes)) return "large"
      return ""
    }

    function imageMediaType(file) {
      if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(file?.type ?? ""))) return file.type
      const ext = String(file?.name ?? "").split(".").pop()?.toLowerCase() ?? ""
      return IMAGE_MEDIA[ext] ?? ""
    }

    function useScopeSnapshot(scope) {
      return React.useSyncExternalStore(
        (listener) => scope?.subscribe?.(listener) ?? (() => {}),
        () => scope?.getSnapshot?.(),
      )
    }

    /** Follow the plugin's own EN/RU setting; never the Harness locale. */
    function useConfigText(scope, fallbackText) {
      const snapshot = useScopeSnapshot(scope)
      const lang = configLanguage(snapshot?.value?.language)
      return { t: TEXT[lang] ?? fallbackText ?? TEXT.en, lang }
    }

    function describeRejection(field, scope) {
      const snapshot = scope?.getSnapshot?.() ?? {}
      const reasons = []
      if (snapshot.status === "unavailable") reasons.push("namespace плагина не смонтирован")
      if (snapshot.writable === false) reasons.push("запись настроек запрещена")
      if (snapshot.status && snapshot.status !== "available") {
        reasons.push(`состояние формы: ${snapshot.status}`)
      }
      if (Number.isFinite(snapshot.revision)) reasons.push(`ревизия ${snapshot.revision}`)
      return `Host отклонил «${field}»: ${reasons.join(", ") || "неизвестная причина"}`
    }

    async function writeConfig(scope, patch) {
      let field = Object.keys(patch)[0] ?? "config"
      for (const [name, value] of Object.entries(patch)) {
        field = name
        let accepted
        try {
          accepted = await scope.set(name, value)
        } catch (error) {
          throw new Error(`Host отклонил «${field}»: ${error?.message ?? error}`)
        }
        if (accepted === false) throw new Error(describeRejection(field, scope))
      }
    }

    const UNAVAILABLE_SNAPSHOT = Object.freeze({ status: "unavailable", writable: false })

    /** Stable read-only scope: React requires getSnapshot() to be referentially stable. */
    const DEGRADED_SCOPE = Object.freeze({
      getSnapshot: () => UNAVAILABLE_SNAPSHOT,
      subscribe: () => () => {},
      set: async () => false,
    })

    function resolveSettingsScope(ctx, cache) {
      const forms = ctx.get?.("configForms")
      if (forms !== undefined) {
        let namespaces = []
        try {
          const view = forms.describe?.().getSnapshot?.()
          namespaces = Array.isArray(view?.view?.namespaces)
            ? view.view.namespaces.map((row) => (typeof row === "string" ? row : row?.ns)).filter(Boolean)
            : []
        } catch {
          namespaces = []
        }
        const match =
          namespaces.find((ns) => ns === "dsh-q-image-studio") ??
          namespaces.find((ns) => ns.endsWith(":dsh-q-image-studio"))
        if (match !== undefined) return forms.get(match)
      }
      const legacy = ctx.get?.("settingsScope")
      if (legacy?.bind) {
        if (cache?.legacy !== undefined) return cache.legacy
        const bound = legacy.bind({ namespace: "dsh-q-image-studio" })
        if (cache) cache.legacy = bound
        return bound
      }
      return DEGRADED_SCOPE
    }

    /**
     * Lazy scope facade: the settings namespace can mount after this plugin's
     * apply(), so the card keeps watching configForms and switches to the real
     * form as soon as it appears. The facade also owns the subscription so a
     * late namespace re-renders the card instead of leaving a dead stub.
     */
    function createSettingsScopeStore(ctx) {
      const cache = {}
      let scope = resolveSettingsScope(ctx, cache)
      let mirror = null
      let offMirror = null
      let offScope = null
      let timer = null
      const listeners = new Set()

      const notify = () => {
        for (const listener of [...listeners]) listener()
      }
      const bindScope = () => {
        offScope?.()
        offScope = typeof scope?.subscribe === "function" ? scope.subscribe(notify) : null
      }
      const sync = () => {
        const forms = ctx.get?.("configForms")
        const nextMirror = forms?.describe?.()
        if (nextMirror !== undefined && nextMirror !== mirror) {
          offMirror?.()
          mirror = nextMirror
          offMirror = typeof mirror.subscribe === "function" ? mirror.subscribe(sync) : null
          mirror.ensure?.()
        }
        const next = resolveSettingsScope(ctx, cache)
        if (next !== scope) {
          scope = next
          bindScope()
          notify()
        }
      }

      return {
        getSnapshot: () => scope?.getSnapshot?.() ?? UNAVAILABLE_SNAPSHOT,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            bindScope()
            sync()
            timer = setInterval(sync, 300)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size > 0) return
            if (timer !== null) clearInterval(timer)
            timer = null
            offMirror?.()
            offMirror = null
            mirror = null
            offScope?.()
            offScope = null
          }
        },
        set: (...args) => (typeof scope?.set === "function" ? scope.set(...args) : Promise.resolve(false)),
        retry: () => {
          sync()
          notify()
        },
      }
    }

    function scopeReady(snapshot) {
      return snapshot !== undefined && snapshot !== null && snapshot.value !== undefined && snapshot.value !== null
    }

    const STYLE = `
      .is-settings {
        --qis-accent: var(--dsw-static-violet-600);
        display: flex; flex-direction: column; gap: 14px; max-width: 680px;
        color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13);
      }
      .is-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .is-row > * { min-width: 0; }
      .is-grow { flex: 1; }
      .is-field { display: grid; grid-template-columns: 120px minmax(0, 1fr); align-items: center; gap: 12px; }
      .is-field > span {
        display: flex; align-items: center; min-height: 38px;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); line-height: 1.3;
      }
      .is-lang-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .is-lang-block { display: flex; align-items: center; gap: 8px; width: 168px; flex: 0 0 168px; }
      .is-lang-label {
        width: 76px; flex: 0 0 76px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .is-lang-row .is-check { flex: 0 0 100px; width: 100px; margin-left: auto; }
      .is-input, .is-select, .is-textarea {
        box-sizing: border-box; width: 100%; min-width: 0;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13);
      }
      .is-input, .is-select { height: 38px; padding: 0 12px; }
      .is-select option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .is-textarea { min-height: 88px; padding: 9px 10px; resize: vertical; line-height: 1.45; }
      .is-input::placeholder, .is-textarea::placeholder { color: var(--dsw-alias-label-caption); }
      .is-dropdown { position: relative; min-width: 0; }
      .is-dropdown-trigger {
        box-sizing: border-box; display: block; position: relative; width: 100%; height: 38px;
        padding: 0 38px 0 12px; text-align: left; overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13); cursor: pointer;
      }
      .is-dropdown-trigger:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }
      .is-dropdown-trigger:focus-visible { outline: 2px solid var(--qis-accent); outline-offset: 2px; }
      .is-dropdown-trigger:disabled { opacity: .55; cursor: default; }
      .is-dropdown-value { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .is-chevron {
        position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
        display: inline-flex; color: var(--dsw-alias-label-caption); pointer-events: none;
      }
      .is-dropdown-panel {
        position: absolute; left: 0; right: 0; top: calc(100% + 5px); z-index: 30;
        box-sizing: border-box; width: 100%; max-height: 264px; overflow-y: auto;
        overscroll-behavior: contain; padding: 5px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 14px 34px color-mix(in srgb, var(--dsw-alias-bg-base) 68%, transparent);
      }
      .is-dropdown-panel.is-up { top: auto; bottom: calc(100% + 5px); }
      .is-dropdown-option {
        box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 10px;
        width: 100%; min-height: 34px; padding: 7px 9px; border: 0; border-radius: var(--dsw-radius-xs);
        background: none; color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-13);
        text-align: left; cursor: pointer;
      }
      .is-dropdown-option.is-active { background: var(--dsw-alias-interactive-bg-hover); }
      .is-dropdown-option.is-selected { background: color-mix(in srgb, var(--qis-accent) 12%, transparent); }
      .is-dropdown-option:disabled { opacity: .45; cursor: default; }
      .is-dropdown-option:focus-visible { outline: 2px solid var(--qis-accent); outline-offset: -2px; }
      .is-dropdown-option-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .is-checkmark { color: var(--qis-accent); font-weight: 700; flex: none; }
      .is-dropdown-option.is-dropdown-manual {
        justify-content: flex-start; margin-top: 5px; padding-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1);
        border-radius: 0 0 var(--dsw-radius-xs) var(--dsw-radius-xs);
        color: var(--qis-accent);
      }
      .is-dropdown-option.is-dropdown-manual .is-dropdown-option-label { flex: 1; text-align: left; }
      .is-dropdown-empty { display: block; padding: 9px; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); }
      .is-input:disabled, .is-select:disabled {
        color: var(--dsw-alias-label-caption);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 55%, transparent);
        cursor: not-allowed;
      }
      .is-input:focus-visible, .is-select:focus-visible, .is-textarea:focus-visible,
      .is-btn:focus-visible {
        outline: 2px solid var(--qis-accent);
        outline-offset: 2px;
      }
      .is-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        box-sizing: border-box; height: 34px; padding: 0 12px; white-space: nowrap;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13); cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      .is-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .is-btn:disabled { opacity: .45; cursor: default; }
      .is-badge { color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); }
      .is-error { color: var(--dsw-alias-state-error-primary); font: var(--dsw-font-xxs-12); }
      .is-status {
        display: inline-flex; align-items: center; align-self: flex-start; gap: 6px;
        font: var(--dsw-font-xxs-strong-12); font-weight: 600;
      }
      .is-status.is-checking { color: var(--dsw-alias-label-secondary); font-weight: 500; }
      .is-status.is-ok {
        padding: 3px 9px; border-radius: var(--dsw-radius-lg);
        color: var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary));
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary)) 12%, transparent);
      }
      .is-status.is-bad { color: var(--dsw-alias-state-error-primary); }
      .is-dots { display: inline-flex; align-items: center; gap: 4px; }
      .is-dots span {
        width: 5px; height: 5px; border-radius: 50%;
        background: linear-gradient(135deg,
          var(--dsw-static-violet-600),
          color-mix(in srgb, var(--dsw-static-blue-400) 58%, var(--dsw-static-green-400)));
        box-shadow: 0 0 5px color-mix(in srgb, var(--dsw-static-violet-400) 72%, transparent);
        animation: is-dot 1.5s ease-in-out infinite;
      }
      .is-dots span:nth-child(2) { animation-delay: .2s; }
      .is-dots span:nth-child(3) { animation-delay: .4s; }
      @keyframes is-dot {
        0%, 70%, 100% { opacity: .3; transform: scale(.88); }
        30% { opacity: 1; transform: scale(1); }
      }
      @property --qis-angle {
        syntax: "<angle>";
        inherits: false;
        initial-value: 0deg;
      }
      .is-page.is-animating .is-generate { position: relative; }
      .is-page.is-animating .is-generate::after {
        content: ""; position: absolute; inset: -3px; padding: 2px;
        border-radius: inherit; pointer-events: none;
        background: conic-gradient(from var(--qis-angle),
          var(--dsw-static-violet-600),
          color-mix(in srgb, var(--dsw-static-blue-400) 58%, var(--dsw-static-green-400)),
          var(--dsw-static-blue-400),
          color-mix(in srgb, var(--dsw-static-violet-500, var(--dsw-static-blue-400)) 62%, var(--dsw-static-violet-600)),
          var(--dsw-static-violet-600));
        -webkit-mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0);
        mask-composite: exclude;
        animation: is-neon-spin 2.8s linear infinite;
        filter: drop-shadow(0 0 4px color-mix(in srgb, var(--dsw-static-violet-400) 82%, transparent))
          drop-shadow(0 0 9px color-mix(in srgb, var(--dsw-static-blue-400) 52%, transparent));
      }
      .is-page.is-animating .is-generate:disabled { opacity: 1; }
      .is-page.is-no-motion .is-generate[data-busy="true"]::after {
        content: ""; position: absolute; inset: -3px; padding: 2px;
        border-radius: inherit; pointer-events: none; opacity: .85;
        background: linear-gradient(120deg,
          var(--dsw-static-violet-600),
          color-mix(in srgb, var(--dsw-static-blue-400) 58%, var(--dsw-static-green-400)),
          var(--dsw-static-violet-600));
        -webkit-mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0);
        mask-composite: exclude;
      }
      .is-page.is-no-motion .is-generate[data-busy="true"] { position: relative; }
      .is-page.is-no-motion .is-generate[data-busy="true"]:disabled { opacity: .92; }
      .is-no-motion .is-generate::after, .is-no-motion .is-dots span { animation: none; }
      @keyframes is-neon-spin { to { --qis-angle: 1turn; } }
      .is-gen-short { display: none; }
      @container (max-width: 359px) {
        .is-gen-full { display: none; }
        .is-gen-short { display: inline; }
      }
      .is-seg {
        display: inline-flex; padding: 2px; gap: 2px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
      }
      .is-seg {
        padding: 2px; gap: 2px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 65%, transparent);
      }
      .is-seg.is-language { display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-width: 0; }
      .is-seg-btn {
        border: 0; border-radius: var(--dsw-radius-xs); padding: 2px 8px;
        background: transparent; color: var(--dsw-alias-label-secondary); opacity: .62;
        font: var(--dsw-font-xxs-strong-12); cursor: pointer;
        transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
      }
      .is-seg.is-language .is-seg-btn { padding: 3px 0; text-align: center; }
      .is-seg-btn:hover:not(.is-active) { opacity: 1; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .is-seg-btn.is-active {
        opacity: 1;
        background: var(--qis-accent);
        color: var(--dsw-static-neutral-bluish-00);
        box-shadow: 0 1px 2px color-mix(in srgb, var(--qis-accent) 35%, transparent);
      }
      .is-check {
        display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); cursor: pointer;
      }
      .is-check input { margin: 0; accent-color: var(--qis-accent); }
      .is-warning {
        color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary));
        font: var(--dsw-font-xxs-12);
      }
      @media (prefers-reduced-motion: reduce) {
        .is-dots { display: none; }
        .is-page.is-animating .is-generate::after { display: none; }
      }
      .is-hidden-input { display: none; }
      .is-stack { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .is-picker { display: flex; gap: 8px; min-width: 0; }
      .is-picker .is-input { flex: 1; }
      .is-picker .is-btn { flex: 0 0 auto; }
      .is-link {
        border: 0; padding: 0; background: none; cursor: pointer;
        color: var(--qis-accent); font: inherit; text-decoration: none;
      }
      .is-link:hover { text-decoration: underline; }
      .is-hidden-note {
        margin: 0; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12);
      }
      .is-link:focus-visible, .is-icon-btn:focus-visible, .is-card-image:focus-visible {
        outline: 2px solid var(--qis-accent); outline-offset: 2px;
      }

      .is-page {
        --qis-accent: var(--dsw-static-violet-600);
        container-type: inline-size;
        box-sizing: border-box; height: 100%; min-width: 0;
        display: flex; gap: 16px; padding: 14px 18px 16px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13); overflow: hidden;
      }
      .is-page-side {
        flex: 0 0 clamp(328px, 25vw, 360px); width: clamp(328px, 25vw, 360px);
        min-height: 0; display: flex; flex-direction: column; gap: 12px;
        overflow-y: auto; overflow-x: clip; padding: 2px 10px 6px;
      }
      .is-page-brand { display: flex; align-items: center; gap: 10px; flex: none; padding: 2px 2px 0; }
      .is-k8-icon { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 5px; }
      .is-k8-plate {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        padding: 2px; flex: none; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
      }
      .is-k8-plate .is-k8-icon { width: 100%; height: 100%; max-width: none; max-height: none; }
      .is-brand-mark {
        width: 32px; height: 32px; border-radius: 10px; flex: none; padding: 2px;
        box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l2);
      }
      .is-page-title { margin: 0; font: var(--dsw-font-m-18); letter-spacing: -.01em; }
      .is-page .is-page-form { flex: 1 1 auto; min-height: 0; background: transparent; border: 0; padding: 0; gap: 11px; }
      .is-page .is-file { flex: 0 0 128px; width: 128px; }
      .is-page-form .is-connect { grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); }
      .is-page-form .is-ref-zone { margin-top: auto; }
      .is-page-form .is-fieldset { gap: 6px; }
      .is-page-form .is-prompt-field { gap: 5px; }
      .is-prompt-box { position: relative; display: flex; flex-direction: column; }
      .is-prompt-box textarea {
        box-sizing: border-box; width: 100%; min-height: 104px; max-height: 25vh;
        resize: none !important; overflow-y: hidden; padding-bottom: 26px;
      }
      .is-prompt-meta {
        position: absolute; right: 10px; bottom: 7px; pointer-events: none;
        color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12);
      }
      .is-ref-zone {
        box-sizing: border-box; border: 1px dashed var(--dsw-alias-border-l3);
        border-radius: 12px; padding: 8px; display: flex; flex-direction: column; gap: 7px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent);
        transition: border-color 140ms ease, background 140ms ease;
      }
      .is-ref-zone.is-over {
        border-color: var(--qis-accent);
        background: color-mix(in srgb, var(--qis-accent) 10%, var(--dsw-alias-bg-layer-1));
      }
      .is-ref-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .is-ref-head .is-label { white-space: nowrap; flex: 0 0 auto; }
      .is-ref-head .is-hint { text-align: right; min-width: 0; }
      .is-ref-list { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 48px; }
      .is-ref-thumb {
        position: relative; width: 48px; height: 48px; border-radius: 10px;
        overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3);
      }
      .is-ref-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .is-ref-thumb button {
        position: absolute; top: 1px; right: 1px; width: 17px; height: 17px; padding: 0;
        border: 0; border-radius: 50%; cursor: pointer; line-height: 15px; font-size: 12px;
        color: var(--dsw-static-neutral-bluish-00); background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
      }
      .is-ref-thumb button:hover { background: var(--dsw-alias-state-error-primary); }
      .is-ref-add {
        width: 48px; height: 48px; border-radius: 10px; cursor: pointer; flex: none;
        border: 1px dashed var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary);
        display: flex; align-items: center; justify-content: center; font-size: 21px; line-height: 1;
      }
      .is-ref-add:hover { border-color: var(--qis-accent); color: var(--qis-accent); }
      .is-ref-add:focus-within { outline: 2px solid var(--qis-accent); outline-offset: 2px; }
      .is-page-actions { margin-top: 1px; }
      .is-page-actions .is-generate { width: 100%; }

      .is-page-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
      .is-canvas-panel {
        flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
        background: var(--dsw-alias-bg-layer-1); overflow: hidden;
      }
      .is-canvas-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 12px 8px; }
      .is-canvas-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
      .is-canvas-title { margin: 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); }
      .is-canvas-chip {
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 2px 8px;
        color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; flex: 0 1 auto;
      }
      .is-canvas-seed { margin-left: auto; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); white-space: nowrap; }
      .is-canvas-stage {
        flex: 1 1 auto; min-height: 0; margin: 0 10px; border-radius: 12px;
        background: var(--dsw-alias-bg-layer-3); overflow: hidden; position: relative;
        display: flex; align-items: center; justify-content: center;
      }
      .is-canvas-empty { margin: 0; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); }
      .is-canvas-media { width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 8px; box-sizing: border-box; }
      .is-canvas-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 6px; }
      .is-canvas-cell {
        position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0;
        display: flex; align-items: center; justify-content: center; container-type: size;
      }
      .is-canvas-frame {
        position: relative; width: min(100%, calc(100cqh * var(--ar, 1))); max-height: 100%;
        aspect-ratio: var(--ar, 1); display: flex; align-items: center; justify-content: center;
      }
      .is-canvas-tile { width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; border-radius: 8px; overflow: hidden; }
      .is-canvas-tile.is-removed {
        border: 1px dashed var(--dsw-alias-border-l3); box-sizing: border-box;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent);
        color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12);
      }
      .is-tile-actions {
        position: absolute; right: 8px; bottom: 8px; z-index: 2;
        display: flex; gap: 2px; padding: 3px; border-radius: 10px;
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);
        border: 1px solid var(--dsw-alias-border-l2); backdrop-filter: blur(6px);
        opacity: 0; transition: opacity 160ms ease;
      }
      .is-canvas-cell:hover .is-tile-actions, .is-canvas-cell:focus-within .is-tile-actions { opacity: 1; }
      .is-tile-actions .is-icon-btn { width: 26px; height: 26px; }
      .is-canvas-tile.is-clickable { border: 0; padding: 0; background: transparent; cursor: zoom-in; }
      .is-canvas-tile.is-clickable:hover img { transform: scale(1.005); }
      .is-canvas-tile.is-clickable:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--qis-accent)); outline-offset: -2px; }
      .is-canvas-tile.is-clickable img { transition: transform 180ms ease; }
      .is-canvas-tile img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: 6px; }
      .is-canvas-placeholder {
        width: 100%; height: 100%; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
      }
      .is-canvas-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px 10px; min-height: 38px; }
      .is-canvas-meta { color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .is-history-panel {
        flex: 0 0 188px; min-height: 0; display: flex; flex-direction: column;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
        background: var(--dsw-alias-bg-layer-1); padding: 8px 10px 8px;
      }
      .is-history-head { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 0 2px 6px; }
      .is-history-heading { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .is-history-help { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .is-history-title { margin: 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); }
      .is-history-count { color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); }
      .is-history-hint { margin-left: auto; }
      .is-history-scroll { flex: 1 1 auto; min-height: 0; display: flex; gap: 14px; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
      .is-history-group { flex: none; display: flex; flex-direction: column; gap: 3px; }
      .is-history-day { margin: 0 2px; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxxs-strong-11); text-transform: uppercase; letter-spacing: .07em; }
      .is-history-row { display: flex; gap: 8px; }
      .is-history-card {
        position: relative; width: 132px; flex: 0 0 132px; margin: 0; padding: 0;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-3); cursor: pointer;
      }
      .is-history-card.is-in-refs {
        border-color: var(--qis-accent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--qis-accent) 45%, transparent);
      }
      .is-history-card.is-in-refs .is-history-thumb img { opacity: .55; filter: saturate(.75); }
      .is-history-card.is-in-refs .is-history-label { color: var(--dsw-alias-label-secondary); }
      .is-history-ref-badge { top: 5px; left: 5px; padding: 1px 6px; font-size: 10px; }
      .is-history-card:focus-visible { outline: 2px solid var(--qis-accent); outline-offset: 1px; }
      .is-history-thumb { position: relative; height: 88px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
      .is-history-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .is-history-add {
        position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-bg-base) 40%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
        color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 19px; padding: 0; cursor: pointer;
        opacity: 0; transition: opacity 140ms ease, background 140ms ease;
      }
      .is-history-add:hover { background: var(--qis-accent); color: var(--dsw-static-neutral-bluish-00); }
      .is-history-actions {
        position: absolute; left: 4px; right: 4px; bottom: 4px; padding: 2px;
        display: flex; justify-content: center; gap: 2px; border-radius: 7px;
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent);
        opacity: 0; transition: opacity 140ms ease;
      }
      .is-history-actions .is-icon-btn { width: 23px; height: 23px; }
      .is-history-card:hover .is-history-add, .is-history-card:hover .is-history-actions,
      .is-history-card:focus-within .is-history-add, .is-history-card:focus-within .is-history-actions { opacity: 1; }
      .is-history-label {
        margin: 4px 6px 5px; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12);
        line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .is-history-more { flex: 0 0 auto; align-self: flex-end; margin-bottom: 4px; }
      .is-page-toast {
        position: fixed; right: 24px; bottom: 24px; z-index: 40;
        padding: 8px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3);
        border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xxs-12); box-shadow: var(--dsw-shadow-lv2);
      }
      @container (max-width: 1280px) {
        .is-page { gap: 12px; padding: 12px 14px 14px; }
        .is-page-side { flex-basis: 320px; width: 320px; }
        .is-history-panel { flex-basis: 180px; }
                .is-history-card { width: 124px; flex-basis: 124px; }
        .is-history-thumb { height: 82px; }
      }
      @container (max-width: 900px) {
        .is-page { flex-direction: column; overflow-y: auto; }
        .is-page-side { flex: none; width: 100%; overflow: visible; }
        .is-page-main { flex: none; min-height: 540px; }
      }

      .is-lightbox {
        position: fixed; inset: 0; z-index: 120;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; box-sizing: border-box;
        background: rgba(0, 0, 0, .72);
        -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
        animation: is-lb-fade 180ms ease-out;
      }
      .is-lb-card {
        position: relative; box-sizing: border-box;
        width: min(1180px, 100%); height: min(92vh, 820px);
        display: grid; grid-template-columns: minmax(0, 1fr) 390px;
        overflow: hidden; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 18px; background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 32px 90px rgba(0, 0, 0, .55);
        animation: is-lb-card-in 180ms cubic-bezier(.2, .75, .25, 1);
      }
      .is-lb-media {
        position: relative; min-width: 0; min-height: 0;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden; background: var(--dsw-alias-bg-base);
      }
      .is-lb-media img { width: 100%; height: 100%; object-fit: contain; display: block; }
      .is-lb-media.is-transparent {
        background-image:
          linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent) 25%, transparent 25%),
          linear-gradient(-45deg, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent) 75%),
          linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent) 75%);
        background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0;
      }
      .is-lb-panel {
        position: relative; min-height: 0; overflow-y: auto;
        display: flex; flex-direction: column; gap: 14px;
        padding: 22px 22px 20px; box-sizing: border-box;
        border-left: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .is-lb-close {
        position: absolute; top: 12px; right: 12px; z-index: 1;
        width: 28px; height: 28px; padding: 0; border-radius: 50%;
        border: 1px solid transparent; background: transparent;
        color: var(--dsw-alias-label-secondary); font-size: 18px; line-height: 1; cursor: pointer;
      }
      .is-lb-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .is-lb-title { margin: 0 26px 0 0; font: var(--dsw-font-base-16); font-weight: 600; }
      .is-lb-details { display: flex; flex-direction: column; gap: 11px; margin: 0; }
      .is-lb-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .is-lb-label {
        margin: 0; color: var(--dsw-alias-label-caption);
        font: var(--dsw-font-xxxs-strong-11); letter-spacing: .06em; text-transform: uppercase;
      }
      .is-lb-value {
        margin: 0; color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xxs-12); line-height: 1.55; overflow-wrap: anywhere;
      }
      .is-lb-note { margin-left: 6px; color: var(--dsw-alias-label-caption); }
      .is-lb-sub { color: var(--dsw-alias-label-caption); }
      .is-lb-link {
        margin-left: 7px; padding: 0; border: 0; background: transparent;
        color: var(--qis-accent); font: var(--dsw-font-xxs-12); cursor: pointer;
      }
      .is-lb-link:hover { text-decoration: underline; }
      .is-lb-actions { display: flex; flex-direction: column; gap: 7px; margin-top: auto; padding-top: 6px; }
      .is-lb-actions .is-btn { width: 100%; }
      .is-lb-actions .is-primary {
        border-color: transparent; background: var(--qis-accent);
        color: var(--dsw-static-neutral-bluish-00); font-weight: 600;
      }
      .is-lb-actions .is-primary:hover:not(:disabled) { background: var(--dsw-static-violet-400); }
      .is-lb-missing {
        display: flex; flex-direction: column; align-items: center; gap: 12px;
        padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xs-13);
      }
      .is-lightbox.is-closing { animation: is-lb-fade-out 160ms ease-in forwards; }
      .is-lightbox.is-closing .is-lb-card { animation: is-lb-card-out 160ms ease-in forwards; }
      .is-lightbox.is-static, .is-lightbox.is-static .is-lb-card { animation: none; }
      @keyframes is-lb-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes is-lb-fade-out { from { opacity: 1; } to { opacity: 0; } }
      @keyframes is-lb-card-in { from { opacity: 0; transform: scale(.97) translateY(4px); } to { opacity: 1; transform: none; } }
      @keyframes is-lb-card-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.98); } }
      @container (max-width: 900px) {
        .is-lb-card { grid-template-columns: minmax(0, 1fr) 340px; }
        .is-lb-panel { padding: 18px 16px 16px; gap: 10px; }
      }
      @container (max-width: 700px) {
        .is-lightbox { padding: 12px; }
        .is-lb-card { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 1fr) auto; height: 94vh; }
        .is-lb-panel { border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1); max-height: 48%; }
      }
      @media (prefers-reduced-motion: reduce) {
        .is-lightbox, .is-lb-card, .is-lightbox.is-closing, .is-lightbox.is-closing .is-lb-card { animation: none; }
      }

      .is-panel {
        --qis-accent: var(--dsw-static-violet-600);
        container-type: inline-size;
        box-sizing: border-box; height: 100%; overflow: hidden;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xs-13); min-width: 0;
        display: flex; flex-direction: column;
      }
      .is-shell {
        box-sizing: border-box; width: 100%; max-width: 720px; margin: 0 auto;
        height: 100%; min-height: 0; padding: 12px 20px 14px;
        display: flex; flex-direction: column; gap: 10px; min-width: 0;
      }
      .is-head {
        flex: none;
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        margin: -8px -8px 0; padding: 8px;
        border-radius: var(--dsw-radius-md);
        background: linear-gradient(180deg, color-mix(in srgb, var(--qis-accent) 3%, transparent), transparent);
      }
      .is-title { margin: 0; font: var(--dsw-font-base-16); font-weight: 600; letter-spacing: -.01em; }
      .is-close { width: 30px; height: 30px; padding: 0; font-size: 18px; line-height: 1; }
      .is-form {
        flex: none;
        display: flex; flex-direction: column; gap: 5px; min-width: 0;
        padding: 10px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
      }
      .is-connect { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
      .is-fieldset { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .is-mode-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
      .is-mode-row .is-mode { flex: 0 1 206px; }
      .is-mode-row .is-mode-hint { margin: 0; flex: 1 1 140px; font-size: 11px; line-height: 1.35; }
      .is-form .is-connect .is-label { min-height: 14px; font-size: 11px; line-height: 14px; }
      .is-form .is-connect .is-label span { line-height: 14px; }
      .is-form .is-hint { font-size: 11px; line-height: 14px; }
      .is-form .is-dropdown-trigger, .is-form .is-input { height: 34px; }
      .is-form .is-fieldset { gap: 4px; }
      .is-prompt-head { flex-wrap: wrap; justify-content: flex-start; gap: 5px 8px; min-width: 0; }
      .is-prompt-head .is-refs-inline { margin-left: auto; }
      .is-prompt-head .is-guide { margin-left: auto; }
      .is-refs-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
      .is-refs-head { width: 110px; flex: 0 0 110px; text-align: right; }
      .is-refs-small .is-ref { width: 32px; height: 32px; }
      .is-refs-small .is-ref button { width: 15px; height: 15px; font-size: 9px; }
      .is-prompt { min-height: 48px; height: 48px; padding: 6px 9px; resize: none; line-height: 1.35; }
      .is-size-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
      .is-size-controls > .is-seg {
        display: grid; grid-template-columns: repeat(3, 1fr);
        flex: 0 0 184px; width: 184px;
      }
      .is-size-label { margin: 0; flex: 0 0 100px; width: 100px; }
      .is-size-controls .is-dropdown { flex: 0 0 112px; width: 112px; }
      .is-size-controls .is-chips { flex: 0 1 auto; }
      .is-size-hint {
        margin: 0; flex: 1 1 120px; min-width: 0; font-size: 11px;
        white-space: normal; line-height: 12px;
      }
      .is-seed-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
      .is-seed-row .is-check:first-child { margin-left: 0; flex: 0 0 92px; }
      .is-seed-row .is-check:last-child { margin-left: auto; }
      .is-seed-row .is-label { flex: 0 0 32px; }
      .is-seed-row .is-seed { max-width: 96px; flex: 0 1 96px; }
      .is-results { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
      .is-results-head { flex: none; }
      .is-label {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-strong-12); font-weight: 500;
      }
      .is-hint { margin: 0; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); font-weight: 400; }
      .is-stack .is-hint { line-height: 1.25; }
      .is-save-block { display: flex; flex-direction: column; gap: 6px; }
      .is-save-note {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; flex-wrap: wrap; min-height: 18px;
      }
      .is-profile-delete {
        display: inline-flex; align-items: center; justify-content: center;
        width: 38px; padding: 0;
      }
      .is-profile-delete.is-danger {
        width: auto; padding: 0 10px;
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
      }
      .is-mode {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px;
        padding: 3px; border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2);
      }
      .is-mode-btn {
        min-width: 0; padding: 3px 2px; border: 0; border-radius: var(--dsw-radius-xs);
        white-space: nowrap; line-height: 14px;
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxs-strong-12); font-weight: 500; cursor: pointer;
        transition: background-color 120ms ease, color 120ms ease;
      }
      .is-mode-btn:hover { color: var(--dsw-alias-label-primary); }
      .is-mode-btn.is-active {
        background: color-mix(in srgb, var(--qis-accent) 16%, var(--dsw-alias-bg-layer-1));
        color: var(--dsw-alias-label-primary);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--qis-accent) 38%, transparent);
      }
      .is-mode-hint { margin: -6px 0 0; }
      .is-preset { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .is-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .is-chip {
        padding: 4px 7px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-sm); background: transparent;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); cursor: pointer;
        transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
      }
      .is-chip:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
      .is-chip.is-active {
        border-color: color-mix(in srgb, var(--qis-accent) 65%, transparent);
        background: color-mix(in srgb, var(--qis-accent) 14%, transparent);
        color: var(--dsw-alias-label-primary);
      }
      .is-chip:disabled { opacity: .45; cursor: not-allowed; }
      .is-manual { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      .is-manual-row {
        display: grid; grid-template-columns: 64px minmax(0, 1fr) 82px;
        align-items: center; gap: 10px; min-width: 0;
      }
      .is-manual-row .is-label { margin: 0; }
      .is-range { width: 100%; min-width: 0; accent-color: var(--qis-accent); }
      .is-num { text-align: center; }
      .is-inline { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .is-inline .is-label { margin: 0; flex: 0 0 auto; }
      .is-seed { flex: 1; min-width: 0; max-width: 180px; }
      .is-inline > .is-check:first-child { margin-left: 0; }
      .is-form .is-check { margin-left: 0; }
      .is-error { color: var(--dsw-alias-state-error-primary); }
      .is-warning-box {
        margin: 0; padding: 9px 11px; border-radius: var(--dsw-radius-sm);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary)) 30%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary)) 8%, transparent);
        color: var(--dsw-alias-label-primary); font: var(--dsw-font-xxs-12); line-height: 1.4;
      }
      .is-actions { display: flex; align-items: stretch; gap: 10px; min-width: 0; }
      .is-file { flex: 0 0 136px; width: 136px; position: relative; }
      .is-file:focus-within {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: 2px;
      }
      .is-file-input {
        position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
      }
      .is-generate {
        flex: 1; min-width: 0; border-color: transparent; font-weight: 500;
        background: var(--qis-accent); color: var(--dsw-static-neutral-bluish-00); border-color: transparent;
      }
      .is-generate:hover:not(:disabled) { background: var(--dsw-static-violet-400); }
      .is-alert {
        display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent);
        border-radius: var(--dsw-radius-sm);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
        color: var(--dsw-alias-label-primary); font: var(--dsw-font-xxs-12); line-height: 1.45;
      }
      .is-alert strong {
        display: block; color: var(--dsw-alias-state-error-primary);
        font: var(--dsw-font-xxs-strong-12); font-weight: 600;
      }
      .is-alert-mark {
        flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; border-radius: 50%;
        background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-inverted);
        font: var(--dsw-font-xxxs-strong-11); font-weight: 700;
      }
      .is-refs { display: flex; flex-wrap: wrap; gap: 8px; }
      .is-ref {
        position: relative; width: 56px; height: 56px; border-radius: var(--dsw-radius-sm);
        overflow: hidden; border: 1px solid var(--dsw-alias-border-l2);
      }
      .is-ref img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .is-ref button {
        position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%; cursor: pointer;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        font-size: 11px; line-height: 1;
      }
      .is-results-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .is-h2 { margin: 0; font: var(--dsw-font-s-14); font-weight: 600; }
      .is-count { color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); }
      .is-empty { color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12); margin: 0; }
      .is-toast {
        display: inline-flex; align-items: center; align-self: flex-start;
        margin: 0; padding: 4px 9px; border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
        font: var(--dsw-font-xxs-12);
      }
      .is-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; min-width: 0; }
      .is-card {
        display: flex; flex-direction: column; overflow: hidden; min-width: 0;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-2); transition: border-color 120ms ease;
      }
      .is-card:hover { border-color: var(--dsw-alias-border-l3); }
      .is-card-media { position: relative; min-width: 0; }
      .is-card-image {
        display: block; width: 100%; padding: 0; border: 0; cursor: pointer;
        background: var(--dsw-alias-bg-layer-3);
      }
      .is-card-overlay {
        position: absolute; top: 6px; right: 6px; z-index: 1;
        display: flex; align-items: center; gap: 4px;
      }
      .is-overlay-btn {
        width: 26px; height: 26px; border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l3) 70%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 78%, transparent);
        color: var(--dsw-alias-label-primary);
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .is-overlay-btn:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .is-card img { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: cover; }
      .is-card-body { display: flex; flex-direction: column; gap: 5px; padding: 10px; min-width: 0; }
      .is-card-meta {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12);
      }
      .is-card-size { white-space: nowrap; }
      .is-card-path {
        margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12);
      }
      .is-card-details {
        display: grid; gap: 2px; margin: 2px 0 0; min-width: 0;
        color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxxs-strong-11); font-weight: 400;
      }
      .is-card-details > div { display: flex; gap: 6px; min-width: 0; }
      .is-card-details dt { flex: 0 0 auto; margin: 0; opacity: .75; }
      .is-card-details dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .is-card-actions { display: flex; align-items: center; gap: 2px; margin-top: 2px; }
      .is-icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; width: 28px; height: 28px; padding: 0;
        border: 0; border-radius: var(--dsw-radius-xs); background: transparent;
        color: var(--dsw-alias-label-secondary); cursor: pointer; text-decoration: none;
        transition: background-color 120ms ease, color 120ms ease;
      }
      .is-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .is-icon-btn.is-confirm {
        color: var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
      }
      .is-icon { display: block; flex: 0 0 auto; }
      .is-card {
        box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);
        transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
      }
      .is-card:hover {
        border-color: color-mix(in srgb, var(--qis-accent) 32%, var(--dsw-alias-border-l2));
        transform: translateY(-2px);
        box-shadow: 0 10px 24px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent);
      }
      .is-card.is-in-refs {
        opacity: .55;
        border-color: color-mix(in srgb, var(--qis-accent) 70%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--qis-accent) 55%, transparent);
      }
      .is-card.is-transparent .is-card-media {
        background-color: var(--dsw-alias-bg-layer-1);
        background-image:
          linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent) 25%, transparent 25%),
          linear-gradient(-45deg, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent) 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent) 75%),
          linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent) 75%);
        background-size: 16px 16px;
        background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      }
      .is-ref-badge {
        position: absolute; top: 8px; left: 8px; z-index: 1;
        padding: 2px 7px; border-radius: var(--dsw-radius-lg);
        background: var(--qis-accent); color: var(--dsw-static-neutral-bluish-00);
        font: var(--dsw-font-xxxs-strong-11); font-weight: 600;
      }
      .is-card-actions { gap: 10px; }
      .is-card-buttons { display: flex; flex-direction: column; gap: 5px; margin-top: 3px; }
      .is-card-btn {
        width: 100%; justify-content: flex-start; height: auto; min-height: 28px;
        padding: 4px 8px; border-radius: var(--dsw-radius-xs);
        font: var(--dsw-font-xxxs-strong-11); font-weight: 500;
        white-space: normal; line-height: 1.3; text-align: left;
      }
      .is-card-btn:disabled { opacity: .55; }
      .is-card-details > div:last-child dd { white-space: normal; line-height: 1.35; }
      .is-refs-block { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
      .is-refs-head {
        margin: 0; color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxs-strong-12); font-weight: 500;
      }
      .is-ref { width: 44px; height: 44px; }
      .is-feed {
        display: flex; flex-direction: column; gap: 12px;
        flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
        padding-right: 3px; min-width: 0;
      }
      .is-day { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .is-day-label {
        position: sticky; top: 0; z-index: 1; margin: 0;
        padding: 2px 0; background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-caption);
        font: var(--dsw-font-xxxs-strong-11); font-weight: 600;
        text-transform: uppercase; letter-spacing: .04em;
      }
      .is-show-more { align-self: center; }
      .is-guide { position: relative; display: inline-flex; min-width: 38px; justify-content: flex-end; }
      .is-guide-btn { font: var(--dsw-font-xxs-12); font-weight: 500; }
      .is-guide-modal {
        position: fixed; inset: 0; z-index: 120;
        display: flex; align-items: center; justify-content: center;
        box-sizing: border-box; padding: 24px;
        background: rgba(0, 0, 0, .72); backdrop-filter: blur(3px);
        animation: is-guide-fade 180ms ease-out;
      }
      .is-guide-card {
        display: flex; flex-direction: column; overflow: hidden;
        width: min(720px, 100%); max-height: 88vh;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px;
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
        color: var(--dsw-alias-label-primary);
        animation: is-guide-rise 180ms ease-out;
      }
      .is-guide-head {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
        flex: none; padding: 18px 20px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
      }
      .is-guide-title { margin: 0; font: var(--dsw-font-m-18); font-weight: 600; }
      .is-guide-close {
        width: 32px; height: 32px; flex: none; padding: 0;
        border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-base-16); line-height: 1;
        cursor: pointer;
      }
      .is-guide-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .is-guide-close:focus-visible { outline: 2px solid var(--qis-accent); outline-offset: 2px; }
      .is-guide-scroll {
        flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
        padding: 16px 20px;
      }
      .is-guide-formula {
        margin: 0 0 12px; padding: 7px 9px; border-radius: var(--dsw-radius-sm);
        background: color-mix(in srgb, var(--qis-accent) 10%, transparent);
        color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); font-weight: 500; line-height: 1.5;
      }
      .is-guide-note {
        margin: 0 0 14px; color: var(--dsw-alias-label-tertiary);
        font: var(--dsw-font-xxs-12); font-weight: 400; line-height: 1.5;
      }
      .is-guide-list { display: flex; flex-direction: column; }
      .is-guide-section { display: grid; gap: 3px; margin-top: 16px; }
      .is-guide-section:first-child { margin-top: 0; }
      .is-guide-heading {
        margin: 0; color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxxs-strong-11); font-weight: 600;
        letter-spacing: 0.08em; text-transform: uppercase;
      }
      .is-guide-body, .is-guide-examples {
        margin: 0; color: var(--dsw-alias-label-secondary);
        font: var(--dsw-font-xxs-12); line-height: 1.55;
      }
      .is-guide-examples { display: grid; gap: 3px; padding-left: 14px; list-style: disc; }
      .is-guide-examples li { padding-left: 2px; }
      .is-guide-examples em { font-style: italic; color: var(--dsw-alias-label-primary); }
      .is-guide-foot {
        flex: none; padding: 12px 20px 16px;
        border-top: 1px solid var(--dsw-alias-border-l1);
      }
      .is-guide-modal.is-closing { animation: is-guide-fade 160ms ease-in reverse; }
      .is-guide-modal.is-static, .is-guide-modal.is-static .is-guide-card { animation: none; }
      @keyframes is-guide-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes is-guide-rise { from { transform: translateY(6px); opacity: .4; } to { transform: none; opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .is-guide-modal, .is-guide-card, .is-guide-modal.is-closing { animation: none; }
      }
      @container (min-width: 440px) {
        .is-connect { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
      }
      @container (max-width: 419px) {
        .is-shell { padding: 12px 12px 14px; gap: 10px; }
        .is-form { padding: 12px; gap: 10px; }
        .is-connect { gap: 10px; }
        .is-mode-row .is-mode { flex-basis: 100%; }
        .is-seed-row .is-check:last-child { margin-left: 0; }
        .is-transparent-hint { min-height: 42px; }
        .is-grid { grid-template-columns: minmax(0, 1fr); }
      }
    `

    /** Autosave footer: a permanent explanation, a transient "Saved" chip and a red failure line. */
    function SaveNote({ t, notice, error }) {
      return h(
        "div",
        { className: "is-save-block" },
        h(
          "div",
          { className: "is-save-note" },
          h("span", { className: "is-hint" }, t.autoSaveHint),
          notice ? h("span", { className: "is-status is-ok", role: "status" }, notice) : null,
        ),
        error ? h("div", { className: "is-error", role: "alert" }, error) : null,
      )
    }

    /** Trash button: first click only changes it to the red "Delete?" state. */
    function ProfileDeleteButton({ armed, t, onClick, disabled }) {
      return h(
        "button",
        {
          type: "button",
          className: `is-btn is-profile-delete${armed ? " is-danger" : ""}`,
          onClick,
          disabled,
          title: armed ? t.deleteConfirm : t.deleteProfile,
          "aria-label": armed ? t.deleteConfirm : t.deleteProfile,
        },
        armed ? t.deleteConfirm : h(CardIcon, { name: "delete" }),
      )
    }

    function SettingsCard({ scope, t: fallbackText }) {
      const live = useConfigText(scope, fallbackText)
      const t = live.t
      const lang = live.lang
      const snapshot = useScopeSnapshot(scope)
      const config = snapshot?.value ?? {}
      const providers = Array.isArray(config.providers) ? config.providers : []
      const initialId = config.activeProviderId || providers[0]?.id || ""
      const initialProfile = providers.find((row) => row.id === initialId) ?? providers[0]
      const [activeId, setActiveId] = React.useState(initialId)
      const [draft, setDraft] = React.useState({
        label: initialProfile?.label ?? "",
        baseURL: initialProfile?.baseURL ?? "",
        model: initialProfile?.model ?? "",
      })
      const [keyInfo, setKeyInfo] = React.useState({})
      const [message, setMessage] = React.useState("")
      const [saveDirValue, setSaveDirValue] = React.useState("")
      const [picking, setPicking] = React.useState(false)
      const [checking, setChecking] = React.useState(false)
      const [checkResult, setCheckResult] = React.useState(null)
      const [manual, setManual] = React.useState(false)
      const [armedAt, setArmedAt] = React.useState(0)
      const [saveNotice, setSaveNotice] = React.useState("")
      const migrated = React.useRef(false)
      const autoChecked = React.useRef("")
      const deleteTimer = React.useRef(null)
      const noticeTimer = React.useRef(null)
      const profile = providers.find((row) => row.id === activeId) ?? providers[0]
      const ready = scopeReady(snapshot)

      React.useEffect(() => {
        setArmedAt(0)
        if (deleteTimer.current) clearTimeout(deleteTimer.current)
      }, [activeId])

      React.useEffect(
        () => () => {
          if (deleteTimer.current) clearTimeout(deleteTimer.current)
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
        },
        [],
      )

      function flashNotice(text) {
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        setSaveNotice(text)
        noticeTimer.current = setTimeout(() => setSaveNotice(""), 2000)
      }

      function showError(error) {
        setSaveNotice("")
        setMessage(error.message)
      }

      React.useEffect(() => {
        if (!providers.some((row) => row.id === activeId)) {
          setActiveId(config.activeProviderId || providers[0]?.id || "")
        }
      }, [snapshot?.revision])

      React.useEffect(() => {
        setDraft({
          label: profile?.label ?? "",
          baseURL: profile?.baseURL ?? "",
          model: profile?.model ?? "",
        })
      }, [profile?.id, snapshot?.revision])

      React.useEffect(() => {
        setManual(
          Boolean(profile?.model) &&
            !(Array.isArray(profile?.models) ? profile.models : []).includes(profile.model),
        )
        setCheckResult(null)
      }, [profile?.id])

      React.useEffect(() => {
        if (!ready || profile === undefined) return
        if (!profile.verifiedAt || !profile.baseURL) return
        if (autoChecked.current === profile.id) return
        autoChecked.current = profile.id
        runCheck({ silent: true })
      }, [ready, profile?.id, profile?.verifiedAt])

      React.useEffect(() => {
        if (!ready || migrated.current) return
        const raw = String(config.saveDir ?? "").trim()
        if (raw.length === 0 || raw === "~" || raw.startsWith("~/") || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
          return
        }
        migrated.current = true
        ;(async () => {
          const result = await postJson(ROUTES.keyStatus, {})
          const absolute = typeof result?.saveDir === "string" ? result.saveDir : ""
          if (!absolute) return
          setSaveDirValue(absolute)
          await writeConfig(scope, { saveDir: absolute })
        })().catch((error) => showError(error))
      }, [ready, snapshot?.revision])

      React.useEffect(() => {
        let alive = true
        postJson(ROUTES.keyStatus, {})
          .then((result) => {
            if (!alive) return
            const map = {}
            for (const row of result.providers ?? []) map[row.id] = row
            setKeyInfo(map)
            if (typeof result.saveDir === "string" && result.saveDir.length > 0) {
              setSaveDirValue(result.saveDir)
            }
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      async function refreshKeys() {
        try {
          const result = await postJson(ROUTES.keyStatus, {})
          const map = {}
          for (const row of result.providers ?? []) map[row.id] = row
          setKeyInfo(map)
          if (typeof result.saveDir === "string" && result.saveDir.length > 0) {
            setSaveDirValue(result.saveDir)
          }
        } catch {
          /* the card still works offline */
        }
      }

      async function persistProvider(patch) {
        if (profile === undefined) return
        setMessage("")
        try {
          const next = providers.map((row) => (row.id === profile.id ? { ...row, ...patch } : row))
          await writeConfig(scope, { providers: next })
          setMessage("")
          flashNotice(t.saved)
        } catch (error) {
          setSaveNotice("")
          showError(error)
        }
      }

      async function persistGlobal(patch) {
        setMessage("")
        try {
          await writeConfig(scope, patch)
          setMessage("")
          flashNotice(t.saved)
        } catch (error) {
          setSaveNotice("")
          showError(error)
        }
      }

      async function pickSaveDir() {
        setMessage("")
        setPicking(true)
        try {
          const result = await postJson(ROUTES.pickFolder, {})
          if (result?.cancelled) return
          if (result?.error) throw new Error(result.error)
          if (!result?.path) throw new Error(t.saveDirEmpty)
          const changed = await changeSaveDir({
            saveDir: result.path,
            confirm: (count) => {
              const question = String(t.confirmMigration ?? "").replace("{count}", String(count))
              return typeof globalThis.confirm === "function" ? globalThis.confirm(question) : false
            },
          })
          if (changed?.cancelled) return
          if (changed?.ok === false) throw new Error(changed.error ?? t.failed)
          const next = typeof changed?.saveDir === "string" ? changed.saveDir : result.path
          await writeConfig(scope, { saveDir: next })
          setSaveDirValue(next)
          await refreshKeys()
          flashNotice(t.saved)
        } catch (error) {
          showError(error)
        } finally {
          setPicking(false)
        }
      }

      async function addProfile() {
        setMessage("")
        const id = `p-${Date.now().toString(36)}`
        try {
          await writeConfig(scope, {
            providers: [...providers, newProfile(id)],
            activeProviderId: id,
          })
          setActiveId(id)
          flashNotice(t.saved)
        } catch (error) {
          showError(error)
        }
      }

      async function removeProfile() {
        if (profile === undefined) return
        setMessage("")
        setSaveNotice("")
        try {
          const result = await deleteProfileWithKey({
            profile,
            providers,
            clear: (providerId) => postJson(ROUTES.clearKey, { providerId }),
            write: (patch) => writeConfig(scope, patch),
            errorText: t.clearKeyFailed,
          })
          setArmedAt(0)
          setActiveId(result.activeId)
          flashNotice(t.profileDeleted)
        } catch (error) {
          setSaveNotice("")
          showError(error)
        }
      }

      async function onDeleteClick() {
        if (profile === undefined) return
        if (deleteClickDecision(armedAt) === "delete") {
          if (deleteTimer.current) clearTimeout(deleteTimer.current)
          setArmedAt(0)
          await removeProfile()
          return
        }
        setArmedAt(Date.now())
        if (deleteTimer.current) clearTimeout(deleteTimer.current)
        deleteTimer.current = setTimeout(() => setArmedAt(0), DELETE_CONFIRM_MS)
      }

      async function saveKey() {
        if (profile === undefined) return
        const input = document.getElementById(`dsh-q-image-studio-key-${profile.id}`)
        const value = input?.value ?? ""
        if (value.trim().length === 0) return
        setMessage("")
        try {
          await postJson(ROUTES.saveKey, { providerId: profile.id, value })
          if (input) input.value = ""
          await persistProvider({ models: [], verifiedAt: "", unavailableModels: [] })
          setCheckResult(null)
          setMessage("")
          await refreshKeys()
          flashNotice(t.saved)
        } catch (error) {
          showError(error)
        }
      }

      async function forgetKey() {
        if (profile === undefined) return
        setMessage("")
        try {
          await postJson(ROUTES.clearKey, { providerId: profile.id })
          await persistProvider({ models: [], verifiedAt: "", unavailableModels: [] })
          setCheckResult(null)
          await refreshKeys()
          flashNotice(t.saved)
        } catch (error) {
          showError(error)
        }
      }

      async function runCheck({ silent = false } = {}) {
        if (profile === undefined) return
        if (!silent) {
          setMessage("")
          setChecking(true)
          setCheckResult(null)
        }
        try {
          const result = await postJson(ROUTES.testConnection, { providerId: profile.id })
          const models = Array.isArray(result?.models) ? result.models : []
          if (result?.ok && models.length > 0) {
            const nextModel = models.includes(draft.model) ? draft.model : models[0]
            setDraft((current) => ({ ...current, model: nextModel }))
            setManual(false)
            await persistProvider({
              models,
              verifiedAt: result.verifiedAt ?? new Date().toISOString(),
              model: nextModel,
            })
            setCheckResult({
              ok: true,
              message: `${t.connected} · ${models.length} ${modelsLabel(models.length, lang)}`,
            })
          } else if (result?.ok) {
            if (!silent) await persistProvider({ models: [], verifiedAt: "" })
            setCheckResult({ ok: false, message: t.noModels })
          } else {
            if (!silent) await persistProvider({ models: profile.models ?? [], verifiedAt: "" })
            setCheckResult({ ok: false, message: describeConnectionFailure(result, t) })
          }
        } catch (error) {
          if (!silent) await persistProvider({ models: profile.models ?? [], verifiedAt: "" })
          setCheckResult({ ok: false, message: describeFailure(error.message, t) })
        } finally {
          if (!silent) setChecking(false)
        }
      }

      const checkConnection = () => runCheck()

      const configured = profile ? keyInfo[profile.id]?.configured === true : false
      const readOnlyProfiles = Object.values(keyInfo)
      const readOnlyProfile =
        readOnlyProfiles.find((row) => row.id === activeId) ?? readOnlyProfiles[0]

      if (!ready) {
        return h(
          "div",
          { className: `is-settings${config.animations === false ? " is-no-motion" : ""}` },
          h("div", { className: "is-head" }, h("h2", { className: "is-title" }, t.title)),
          h("div", { className: "is-badge" }, t.settingsUnavailable),
          h(
            "div",
            { className: "is-row" },
            h("span", { className: "is-badge" }, t.profile),
            h(Dropdown, {
              id: "dsh-q-image-studio-readonly-profile",
              className: "is-grow",
              value: readOnlyProfile?.id ?? "",
              options: readOnlyProfiles.map((row) => ({ value: row.id, label: row.label || row.id })),
              onChange: () => {},
              disabled: true,
              placeholder: t.noProvider,
              ariaLabel: t.profile,
            }),
          ),
          readOnlyProfile
            ? h(
                "div",
                { className: "is-settings" },
                h(
                  "label",
                  { className: "is-field" },
                  h("span", null, t.baseUrl),
                  h("input", {
                    className: "is-input",
                    value: readOnlyProfile.baseURL ?? "",
                    readOnly: true,
                  }),
                ),
                h(
                  "label",
                  { className: "is-field" },
                  h("span", null, t.model),
                  h("input", {
                    className: "is-input",
                    value: readOnlyProfile.model ?? "",
                    readOnly: true,
                  }),
                ),
                h("span", { className: "is-badge" }, readOnlyProfile.configured ? t.keySaved : t.noKey),
              )
            : null,
          h(
            "div",
            { className: "is-row" },
            h(
              "button",
              { type: "button", className: "is-btn", onClick: () => scope?.retry?.() },
              t.retry,
            ),
          ),
        )
      }

      return h(
        "div",
        { className: `is-settings${config.animations === false ? " is-no-motion" : ""}` },
        h("div", { className: "is-head" }, h("h2", { className: "is-title" }, t.title)),
        h(
          "div",
          { className: "is-lang-row" },
          h(
            "div",
            { className: "is-lang-block" },
            h("span", { className: "is-badge is-lang-label" }, t.language),
            h(
              "div",
              { className: "is-seg is-language", role: "group", "aria-label": t.language },
              ["en", "ru"].map((code) =>
                h(
                  "button",
                  {
                    key: code,
                    type: "button",
                    className: `is-seg-btn${lang === code ? " is-active" : ""}`,
                    "aria-pressed": lang === code,
                    onClick: () => persistGlobal({ language: code }),
                  },
                  code.toUpperCase(),
                ),
              ),
            ),
          ),
          h(
            "label",
            { className: "is-check" },
            h("input", {
              type: "checkbox",
              checked: config.animations !== false,
              onChange: (event) => persistGlobal({ animations: event.target.checked }),
            }),
            h("span", null, t.animations),
          ),
        ),
        h(
          "div",
          { className: "is-row" },
          h("span", { className: "is-badge" }, t.profile),
          h("span", { className: "is-badge" }, t.profileHint),
        ),
        h(
          "div",
          { className: "is-row" },
          h(Dropdown, {
            id: "dsh-q-image-studio-settings-profile",
            className: "is-grow",
            value: profile?.id ?? "",
            options: providers.map((row, index) => ({ value: row.id, label: profileName(row, index, t) })),
            onChange: setActiveId,
            placeholder: t.profile,
            ariaLabel: t.profile,
          }),
          h("button", { type: "button", className: "is-btn", onClick: addProfile, title: t.add }, "+"),
          h(ProfileDeleteButton, {
            armed: armedAt > 0,
            t,
            onClick: onDeleteClick,
            disabled: profile === undefined,
          }),
        ),
        profile
          ? h(
              "div",
              { className: "is-settings" },
              h(
                "label",
                { className: "is-field" },
                h("span", null, t.nameProfile),
                h(
                  "div",
                  { className: "is-stack" },
                  h("input", {
                    className: "is-input",
                    value: draft.label,
                    placeholder: t.namePlaceholder,
                    onChange: (event) => setDraft({ ...draft, label: event.target.value }),
                    onBlur: () => persistProvider({ label: draft.label.trim() }),
                  }),
                  h("span", { className: "is-hint" }, t.nameHint),
                ),
              ),
              h(
                "label",
                { className: "is-field" },
                h("span", null, t.baseUrl),
                h(
                  "div",
                  { className: "is-stack" },
                  h("input", {
                    className: "is-input",
                    value: draft.baseURL,
                    placeholder: PLACEHOLDER_BASE_URL,
                    onChange: (event) => setDraft({ ...draft, baseURL: event.target.value }),
                    onBlur: () =>
                      persistProvider({
                        baseURL: draft.baseURL.trim(),
                        models: [],
                        verifiedAt: "",
                        unavailableModels: [],
                      }),
                  }),
                  draft.baseURL.trim().length > 0 && !isDashScopeUrl(draft.baseURL)
                    ? h("span", { className: "is-warning" }, t.qwenWarning)
                    : null,
                ),
              ),
              h(
                "label",
                { className: "is-field" },
                h("span", null, t.modelDefault),
                h(
                  "div",
                  { className: "is-stack" },
                  profile.verifiedAt
                    ? manual
                      ? h("input", {
                          className: "is-input",
                          value: draft.model,
                          placeholder: PLACEHOLDER_MODEL,
                          onChange: (event) => setDraft({ ...draft, model: event.target.value }),
                          onBlur: () => persistProvider({ model: draft.model.trim() }),
                        })
                      : h(Dropdown, {
                          id: "dsh-q-image-studio-default-model",
                          value: draft.model,
                          options: [
                            draft.model,
                            ...(Array.isArray(profile.models) ? profile.models : []),
                          ]
                            .filter((name, index, list) => name && list.indexOf(name) === index)
                            .map((name) => ({
                              value: name,
                              label: modelOptionLabel(name, profile.unavailableModels, t),
                            })),
                          onChange: (next) => {
                            setDraft({ ...draft, model: next })
                            persistProvider({ model: next })
                          },
                          placeholder: t.chooseModel,
                          ariaLabel: t.modelDefault,
                          manual: { label: t.enterManually, onSelect: () => setManual(true) },
                        })
                    : h(Dropdown, {
                        id: "dsh-q-image-studio-default-model",
                        value: "",
                        options: [],
                        onChange: () => {},
                        disabled: true,
                        placeholder: t.verifyFirst,
                        ariaLabel: t.modelDefault,
                      }),
                  profile.verifiedAt && manual
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "is-link",
                          onClick: () => setManual(false),
                        },
                        t.useList,
                      )
                    : null,
                  profile.verifiedAt ? null : h("span", { className: "is-hint" }, t.verifyFirst),
                ),
              ),
              h(
                "label",
                { className: "is-field" },
                h("span", null, t.key),
                h("input", {
                  id: `dsh-q-image-studio-key-${profile.id}`,
                  className: "is-input",
                  type: "password",
                  autoComplete: "off",
                  placeholder: configured ? t.keyHidden : t.noKey,
                  onKeyDown: (event) => {
                    if (event.key === "Enter") saveKey()
                  },
                  onBlur: () => saveKey(),
                }),
              ),
              h(
                "label",
                { className: "is-field" },
                h("span", null, t.saveDir),
                h(
                  "div",
                  { className: "is-stack" },
                  h(
                    "div",
                    { className: "is-picker" },
                    h("input", {
                      className: "is-input",
                      value: saveDirValue || config.saveDir || "~/Images/Q-Image-Studio",
                      placeholder: "~/Images/Q-Image-Studio",
                      readOnly: true,
                      "aria-readonly": "true",
                      title: saveDirValue || config.saveDir || "",
                    }),
                    h(
                      "button",
                      { type: "button", className: "is-btn", onClick: pickSaveDir, disabled: picking },
                      picking ? t.picking : t.pickFolder,
                    ),
                  ),
                  h("span", { className: "is-hint" }, t.saveDirHint),
                ),
              ),
              h(
                "div",
                { className: "is-row" },
                h("button", { type: "button", className: "is-btn", onClick: checkConnection, disabled: checking }, t.check),
                h("button", { type: "button", className: "is-btn", onClick: forgetKey }, t.forget),
                h("span", { className: "is-badge" }, configured ? t.keySaved : t.noKey),
              ),
              checking
                ? h(
                    "span",
                    { className: "is-status is-checking", role: "status" },
                    t.checking,
                    h(
                      "span",
                      { className: "is-dots", "aria-hidden": "true" },
                      h("span", null),
                      h("span", null),
                      h("span", null),
                    ),
                  )
                : checkResult
                  ? h(
                      "span",
                      {
                        className: `is-status ${checkResult.ok ? "is-ok" : "is-bad"}`,
                        role: "status",
                      },
                      checkResult.message,
                    )
                  : null,
            )
          : h("div", { className: "is-badge" }, t.add),
        h(SaveNote, { t, notice: saveNotice, error: message }),
      )
    }

    function CardFailure({ message, t, onRetry }) {
      return h(
        "div",
        { className: "is-settings", role: "alert" },
        h(ErrorAlert, { message: `${t.cardError} ${message}`, t }),
        h("button", { type: "button", className: "is-btn", onClick: onRetry }, t.retry),
      )
    }

    class SettingsErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null, attempt: 0 }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      retry() {
        this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
      }

      render() {
        if (this.state.error !== null) {
          const message = String(this.state.error?.message ?? this.state.error)
          return h(CardFailure, { message, t: this.props.t, onRetry: this.retry })
        }
        return this.props.children(this.state.attempt)
      }
    }

    /** Error boundary around the settings card: a render failure must stay visible. */
    function SettingsCardShell(props) {
      const t = props.t ?? text()
      return h(SettingsErrorBoundary, { t }, (attempt) =>
        h(SettingsCard, { ...props, key: attempt }),
      )
    }

    /** File byte sizes for result cards; the gallery index stores no bytes. */
    function useFileSizes(entries, cwd) {
      const [sizes, setSizes] = React.useState({})
      React.useEffect(() => {
        let alive = true
        const missing = entries.filter((entry) => entry?.id && sizes[entry.id] === undefined)
        if (missing.length === 0) return undefined
        ;(async () => {
          for (const entry of missing) {
            try {
              const response = await fetch(fileUrl(cwd, entry.id), {
                method: "HEAD",
                credentials: "same-origin",
              })
              if (!response.ok) continue
              const bytes = Number(response.headers.get("content-length"))
              if (!alive || !Number.isFinite(bytes) || bytes <= 0) continue
              setSizes((previous) =>
                previous[entry.id] === undefined ? { ...previous, [entry.id]: bytes } : previous,
              )
            } catch {
              /* a card without a size still opens the file */
            }
          }
        })()
        return () => {
          alive = false
        }
      }, [cwd, entries])
      return sizes
    }

    function ErrorAlert({ message, t }) {
      return h(
        "div",
        { className: "is-alert", role: "alert" },
        h("span", { className: "is-alert-mark", "aria-hidden": "true" }, "!"),
        h("div", null, h("strong", null, t.errorTitle), message),
      )
    }

    /** The guide is a read-only help dialog: no hover preview and no copy actions. */
    function GuidePopover({ t, lang, initiallyOpen = false, animations = true }) {
      const [open, setOpen] = React.useState(initiallyOpen)
      const [closing, setClosing] = React.useState(false)
      const buttonRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const closingRef = React.useRef(false)
      const closeTimer = React.useRef(null)

      function close() {
        if (closingRef.current) return
        closingRef.current = true
        setClosing(true)
        const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
        closeTimer.current = setTimeout(() => {
          setOpen(false)
          setClosing(false)
          closingRef.current = false
        }, animations === false || reduce ? 0 : 170)
      }

      React.useEffect(
        () => () => {
          clearTimeout(closeTimer.current)
        },
        [],
      )

      React.useEffect(() => {
        if (!open) return undefined
        const node = dialogRef.current
        const focusables = () =>
          Array.from(
            node?.querySelectorAll(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          ).filter((item) => item.offsetParent !== null || item === document.activeElement)
        focusables()[0]?.focus()
        function onKey(event) {
          if (event.key === "Escape") {
            event.preventDefault()
            close()
            return
          }
          if (event.key !== "Tab") return
          const items = focusables()
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener("keydown", onKey)
        return () => {
          document.removeEventListener("keydown", onKey)
          buttonRef.current?.focus?.()
        }
      }, [open])

      return h(
        "div",
        { className: "is-guide" },
        h(
          "button",
          {
            type: "button",
            className: "is-link is-guide-btn",
            ref: buttonRef,
            "aria-expanded": open,
            "aria-haspopup": "dialog",
            onClick: () => {
              if (!open) {
                closingRef.current = false
                setClosing(false)
                setOpen(true)
              }
            },
          },
          t.guide,
        ),
        open
          ? h(
              "div",
              {
                className: `is-guide-modal${animations === false ? " is-static" : ""}${closing ? " is-closing" : ""}`,
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) close()
                },
              },
              h(
                "div",
                {
                  className: "is-guide-card",
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-labelledby": "dsh-q-image-studio-guide-title",
                  ref: dialogRef,
                },
                h(
                  "div",
                  { className: "is-guide-head" },
                  h("h2", { className: "is-guide-title", id: "dsh-q-image-studio-guide-title" }, "Qwen Image Prompt Guide"),
                  h(
                    "button",
                    { type: "button", className: "is-guide-close", title: t.close, "aria-label": t.close, onClick: close },
                    "×",
                  ),
                ),
                h(
                  "div",
                  { className: "is-guide-scroll" },
                  lang === "ru" ? h("p", { className: "is-guide-note" }, t.guideRuHint) : null,
                  h(
                    "p",
                    { className: "is-guide-formula" },
                    "subject + setting + style + camera + atmosphere + detail modifiers. A shorter subject + setting + style also works.",
                  ),
                  h(
                    "div",
                    { className: "is-guide-list" },
                    GUIDE_SECTIONS.map((section) =>
                      h(
                        "section",
                        { key: section.title, className: "is-guide-section" },
                        h("h3", { className: "is-guide-heading" }, section.title),
                        section.body ? h("p", { className: "is-guide-body" }, section.body) : null,
                        section.examples
                          ? h(
                              "ul",
                              { className: "is-guide-examples" },
                              section.examples.map((example) => h("li", null, h("em", null, example))),
                            )
                          : null,
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "is-guide-foot" },
                  h("a", { className: "is-link", href: GUIDE_URL, target: "_blank", rel: "noreferrer" }, t.guideFull),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * Custom listbox: a button plus an absolutely positioned panel. Native
     * <select> popups are painted by the OS, so they cannot open below the
     * field, match its width, or get a roomy chevron. This one does.
     */
    function dropdownUp(rect, viewportHeight) {
      if (!rect || !Number.isFinite(viewportHeight)) return false
      const roomBelow = viewportHeight - rect.bottom
      return roomBelow < 260 && rect.top > roomBelow
    }

    function Dropdown({
      id,
      value,
      options = [],
      onChange,
      disabled = false,
      defaultOpen = false,
      placeholder = "",
      ariaLabel = "",
      className = "",
      manual = null,
    }) {
      const [open, setOpen] = React.useState(defaultOpen)
      const [up, setUp] = React.useState(false)
      const [active, setActive] = React.useState(-1)
      const root = React.useRef(null)
      const trigger = React.useRef(null)
      const items = options.map((option) =>
        typeof option === "string" ? { value: option, label: option } : option,
      )
      const selectedIndex = items.findIndex((option) => String(option.value) === String(value))
      const selected = selectedIndex >= 0 ? items[selectedIndex] : null
      const total = items.length + (manual ? 1 : 0)

      function place() {
        const rect = trigger.current?.getBoundingClientRect?.()
        if (!rect || typeof window === "undefined") return
        setUp(dropdownUp(rect, window.innerHeight))
      }

      function close() {
        setOpen(false)
        setActive(-1)
      }

      function openList(start) {
        if (disabled) return
        place()
        setOpen(true)
        setActive(start === undefined ? Math.max(0, selectedIndex) : start)
      }

      function choose(index) {
        if (index < 0) return
        if (index >= items.length) {
          manual?.onSelect?.()
          close()
          return
        }
        const option = items[index]
        if (option.disabled) return
        onChange?.(option.value)
        close()
      }

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (root.current && !root.current.contains(event.target)) close()
        }
        const onResize = () => place()
        document.addEventListener("pointerdown", onPointer)
        document.addEventListener("scroll", onResize, true)
        window.addEventListener("resize", onResize)
        return () => {
          document.removeEventListener("pointerdown", onPointer)
          document.removeEventListener("scroll", onResize, true)
          window.removeEventListener("resize", onResize)
        }
      }, [open])

      function onKeyDown(event) {
        if (event.key === "Escape") {
          if (open) {
            event.preventDefault()
            close()
          }
          return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          const step = event.key === "ArrowDown" ? 1 : -1
          if (!open) {
            openList()
            return
          }
          let next = active
          for (let guard = 0; guard < total; guard += 1) {
            next = (next + step + total) % total
            if (next >= items.length || !items[next].disabled) break
          }
          setActive(next)
          return
        }
        if (open && event.key === "Enter") {
          event.preventDefault()
          choose(active)
          return
        }
        if (open && (event.key === "Home" || event.key === "End")) {
          event.preventDefault()
          setActive(event.key === "Home" ? 0 : total - 1)
        }
      }

      const activeId = open && active >= 0 ? `${id}-option-${active}` : undefined

      return h(
        "div",
        { className: `is-dropdown${className ? ` ${className}` : ""}`, ref: root, onKeyDown },
        h(
          "button",
          {
            ref: trigger,
            id,
            type: "button",
            className: "is-dropdown-trigger",
            disabled,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            "aria-controls": open ? `${id}-listbox` : undefined,
            "aria-activedescendant": activeId,
            "aria-label": ariaLabel || undefined,
            onClick: () => (open ? close() : openList()),
          },
          h("span", { className: "is-dropdown-value" }, selected ? selected.label : placeholder),
          h("span", { className: "is-chevron", "aria-hidden": "true" }, h("svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M4 6.5 8 10.5l4-4" }))),
        ),
        open
          ? h(
              "div",
              {
                id: `${id}-listbox`,
                className: `is-dropdown-panel${up ? " is-up" : ""}`,
                role: "listbox",
                "aria-label": ariaLabel || undefined,
              },
              items.length === 0
                ? h("span", { className: "is-dropdown-empty" }, placeholder || "—")
                : items.map((option, index) =>
                    h(
                      "button",
                      {
                        key: `${option.value}-${index}`,
                        id: `${id}-option-${index}`,
                        type: "button",
                        role: "option",
                        "aria-selected": index === selectedIndex,
                        className: `is-dropdown-option${index === active ? " is-active" : ""}${index === selectedIndex ? " is-selected" : ""}`,
                        disabled: option.disabled,
                        onMouseEnter: () => setActive(index),
                        onClick: () => choose(index),
                      },
                      h("span", { className: "is-dropdown-option-label" }, option.label),
                      index === selectedIndex
                        ? h("span", { className: "is-checkmark", "aria-hidden": "true" }, "✓")
                        : null,
                    ),
                  ),
              manual
                ? h(
                    "button",
                    {
                      id: `${id}-option-${items.length}`,
                      type: "button",
                      role: "option",
                      "aria-selected": "false",
                      className: `is-dropdown-option is-dropdown-manual${active === items.length ? " is-active" : ""}`,
                      onMouseEnter: () => setActive(items.length),
                      onClick: () => choose(items.length),
                    },
                    h("span", { className: "is-dropdown-option-label" }, manual.label),
                  )
                : null,
            )
          : null,
      )
    }

    const ICONS = {
      copy: ["M5.5 5.5h7v7h-7z", "M10.5 5.5V3.5h-7v7h2"],
      reveal: ["M2 5h4l1.2 1.6H14V13H2z", "M8 8.2v3", "M6.8 9.4 8 8.2l1.2 1.2"],
      hide: ["M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8z", "M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6"],
      delete: ["M3.2 4.6h9.6", "M6.2 4.6V3h3.6v1.6", "M4.3 4.6 4.9 13h6.2l.6-8.4"],
    }

    function CardIcon({ name }) {
      return h(
        "svg",
        {
          className: "is-icon",
          "data-icon": name,
          "aria-hidden": "true",
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        (ICONS[name] ?? []).map((d) => h("path", { key: d, d })),
      )
    }

    function IconAction({ icon, label, ariaLabel, onClick, className, href, download }) {
      const common = {
        className: `is-icon-btn${className ? ` ${className}` : ""}`,
        title: label,
        "aria-label": ariaLabel ?? label,
      }
      if (href) {
        return h("a", { ...common, href, download, target: download ? undefined : "_blank", rel: "noreferrer" },
          h(CardIcon, { name: icon }),
        )
      }
      return h("button", { ...common, type: "button", onClick }, h(CardIcon, { name: icon }))
    }

    function ResultCard({
      entry,
      cwd,
      bytes,
      t,
      lang,
      confirming,
      inRefs,
      onOpen,
      onCopy,
      onHide,
      onDelete,
      onReveal,
      onCopyPrompt,
      onUseSettings,
      onDevelop,
      onReference,
    }) {
      const href = fileUrl(cwd, entry.id)
      const path = entry.file || entry.thumb || entry.id
      const size = formatFileSize(bytes, lang)
      const label = entry.label || entry.id
      const prompt = String(entry.prompt ?? entry.finalPrompt ?? "")
      const row = (name, value) =>
        value === undefined || value === null || value === ""
          ? null
          : h("div", null, h("dt", null, name), h("dd", { title: String(value) }, String(value)))
      return h(
        "article",
        { className: `is-card${inRefs ? " is-in-refs" : ""}${entry.transparent ? " is-transparent" : ""}` },
        h(
          "div",
          { className: "is-card-media" },
          h(
            "button",
            {
              type: "button",
              className: "is-card-image",
              onClick: () => onOpen(entry),
              title: t.openViewer,
              "aria-label": `${t.openViewer}: ${label}`,
            },
            h("img", { src: href, alt: label, loading: "lazy" }),
          ),
          inRefs ? h("span", { className: "is-ref-badge" }, t.inReferences) : null,
        ),
        h(
          "div",
          { className: "is-card-body" },
          h(
            "div",
            { className: "is-card-actions" },
            h(IconAction, {
              icon: "copy",
              label: t.copyImage,
              ariaLabel: `${t.copyImage}: ${label}`,
              onClick: () => onCopyPrompt(entry),
            }),
            h(IconAction, { icon: "reveal", label: t.reveal, onClick: () => onReveal(entry) }),
            h(IconAction, { icon: "hide", label: t.hide, onClick: () => onHide(entry) }),
            h(IconAction, {
              icon: "delete",
              label: confirming ? t.confirmDelete : t.delete,
              ariaLabel: `${t.delete}: ${label}`,
              className: confirming ? "is-confirm" : undefined,
              onClick: () => onDelete(entry),
            }),
          ),
          h(
            "div",
            { className: "is-card-meta" },
            h("span", { className: "is-card-size" }, size || "—"),
            entry.size ? h("span", { className: "is-card-size" }, entry.size) : null,
          ),
          h("p", { className: "is-card-path", title: path }, path),
          h(
            "dl",
            { className: "is-card-details" },
            row(t.model, entry.model),
            row(t.size, entry.size),
            row(t.seed, entry.seed),
            row(t.transparent, entry.transparent ? t.yes : t.no),
            row(t.promptExtend, entry.promptExtend === undefined ? "" : entry.promptExtend ? t.yes : t.no),
            row(t.promptLabel, prompt),
          ),
          h(
            "div",
            { className: "is-card-buttons" },
            h(
              "button",
              {
                type: "button",
                className: "is-btn is-card-btn",
                disabled: inRefs || prompt.length === 0,
                onClick: () => onReference(entry),
              },
              inRefs ? t.inReferences : t.toReferences,
            ),
            h(
              "button",
              { type: "button", className: "is-btn is-card-btn", onClick: () => onUseSettings(entry) },
              t.useSettings,
            ),
            h(
              "button",
              {
                type: "button",
                className: "is-btn is-card-btn",
                disabled: prompt.length === 0,
                onClick: () => onDevelop(entry),
              },
              t.develop,
            ),
          ),
        ),
      )
    }

    function panelClass(animations, busy) {
      return `is-page${animations === false ? " is-no-motion" : animations && busy ? " is-animating" : ""}`
    }

    function Lightbox({
      entry,
      cwd,
      t,
      lang,
      animations = true,
      inRefs = false,
      initialMissing = false,
      index = 0,
      total = 1,
      onClose,
      onNavigate,
      onUse,
      onReference,
      onReveal,
      onRemove,
      returnFocusRef,
    }) {
      const [closing, setClosing] = React.useState(false)
      const [missing, setMissing] = React.useState(Boolean(initialMissing))
      const [copiedSeed, setCopiedSeed] = React.useState(false)
      const [copiedPrompt, setCopiedPrompt] = React.useState(false)
      const dialogRef = React.useRef(null)
      const closingRef = React.useRef(false)
      const closeTimer = React.useRef(null)

      React.useEffect(() => {
        setMissing(Boolean(initialMissing))
        setCopiedSeed(false)
        setCopiedPrompt(false)
      }, [entry.id])

      function requestClose() {
        if (closingRef.current) return
        closingRef.current = true
        setClosing(true)
        const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
        closeTimer.current = setTimeout(onClose, animations === false || reduce ? 0 : 170)
      }

      React.useEffect(() => {
        const node = dialogRef.current
        const previous = returnFocusRef?.current
        const focusables = () =>
          Array.from(
            node?.querySelectorAll(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          ).filter((item) => item.offsetParent !== null || item === document.activeElement)
        focusables()[0]?.focus()
        function onKey(event) {
          if (event.key === "Escape") {
            event.preventDefault()
            requestClose()
            return
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            onNavigate(-1)
            return
          }
          if (event.key === "ArrowRight") {
            event.preventDefault()
            onNavigate(1)
            return
          }
          if (event.key !== "Tab") return
          const items = focusables()
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener("keydown", onKey)
        return () => {
          document.removeEventListener("keydown", onKey)
          clearTimeout(closeTimer.current)
          previous?.focus?.()
        }
      }, [])

      async function copySeed() {
        try {
          await copyText(String(entry.seed))
          setCopiedSeed(true)
          setTimeout(() => setCopiedSeed(false), 1600)
        } catch {
          /* clipboard can be unavailable in insecure contexts */
        }
      }

      async function copyPrompt() {
        try {
          await copyText(entry.prompt || entry.finalPrompt || "")
          setCopiedPrompt(true)
          setTimeout(() => setCopiedPrompt(false), 1600)
        } catch {
          /* ignore */
        }
      }

      const dimensions = entryDimensions(entry)
      const sizeText = dimensions
        ? `${dimensions.width} × ${dimensions.height}`
        : entry.size || "—"
      const pixelsText = dimensions ? `${formatPixels(dimensions.pixels, lang)} px` : ""
      const prompt = entry.prompt || entry.finalPrompt || "—"
      const finalPrompt = entry.finalPrompt || entry.prompt || "—"

      function detail(label, value, extra) {
        return h(
          "div",
          { className: "is-lb-row" },
          h("dt", { className: "is-lb-label" }, label),
          h("dd", { className: "is-lb-value" }, value, extra ?? null),
        )
      }

      return h(
        "div",
        {
          className: `is-lightbox${animations === false ? " is-static" : ""}${closing ? " is-closing" : ""}`,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) requestClose()
          },
        },
        h(
          "div",
          {
            className: "is-lb-card",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "dsh-q-image-studio-lb-title",
            ref: dialogRef,
          },
          h(
            "div",
            { className: `is-lb-media${entry.transparent ? " is-transparent" : ""}` },
            missing
              ? h(
                  "div",
                  { className: "is-lb-missing" },
                  h("p", null, t.fileMissing),
                  h("button", { type: "button", className: "is-btn is-danger", title: t.removeFromHistory, onClick: () => onRemove(entry) }, t.removeFromHistory),
                )
              : h("img", {
                  src: fileUrl(cwd, entry.id),
                  alt: prompt,
                  onError: () => setMissing(true),
                }),
          ),
          h(
            "aside",
            { className: "is-lb-panel" },
            h("button", { type: "button", className: "is-lb-close", title: t.close, "aria-label": t.close, onClick: requestClose }, "×"),
            h("h2", { className: "is-lb-title", id: "dsh-q-image-studio-lb-title" }, t.lightboxTitle),
            h(
              "dl",
              { className: "is-lb-details" },
              detail(t.originalPrompt, prompt),
              detail(t.finalPrompt, finalPrompt),
              detail(t.model, entry.model || "—"),
              detail(
                t.size,
                sizeText,
                pixelsText ? h("span", { className: "is-lb-sub" }, ` · ${pixelsText}`) : null,
              ),
              detail(
                t.seed,
                entry.seed === undefined || entry.seed === null ? "—" : String(entry.seed),
                entry.seed === undefined || entry.seed === null
                  ? null
                  : h("button", { type: "button", className: "is-lb-link", onClick: copySeed }, copiedSeed ? t.copied : t.copyShort),
              ),
              detail(t.transparent, entry.transparent ? t.yes : t.no),
              detail(t.promptExtendLabel, extendLabel(entry, t)),
              detail(t.fileLabel, displayPath(entry.file || "")),
              detail(t.createdLabel, formatDate(entry.createdAt, lang)),
            ),
            h(
              "div",
              { className: "is-lb-actions" },
              h(
                "button",
                { type: "button", className: "is-btn is-primary", title: t.useParameters, disabled: missing, onClick: () => onUse(entry) },
                t.useParameters,
              ),
              h(
                "button",
                { type: "button", className: "is-btn", title: inRefs ? t.inReferences : t.toReferences, disabled: inRefs || missing, onClick: () => onReference(entry) },
                inRefs ? t.inReferences : t.toReferences,
              ),
              h("button", { type: "button", className: "is-btn", title: t.copyPrompt, onClick: copyPrompt }, copiedPrompt ? t.copied : t.copyPrompt),
              h("button", { type: "button", className: "is-btn", title: t.reveal, disabled: missing, onClick: () => onReveal(entry) }, t.reveal),
            ),
          ),
        ),
      )
    }

    function HistoryCard({ entry, cwd, t, lang, confirming, inRefs, onOpen, onCopy, onHide, onDelete, onReveal, onReference }) {
      const label = entry.prompt || entry.finalPrompt || entry.id
      return h(
        "article",
        {
          className: `is-history-card${confirming ? " is-confirming" : ""}${inRefs ? " is-in-refs" : ""}`,
          tabIndex: 0,
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.setData("application/x-dsh-q-image-studio-id", entry.id)
            event.dataTransfer.setData("text/plain", entry.id)
            event.dataTransfer.effectAllowed = "copy"
          },
          onClick: (event) => {
            if (event.target.closest("button")) return
            onOpen(entry)
          },
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            onOpen(entry)
          },
        },
        h(
          "div",
          { className: "is-history-thumb" },
          h("img", { src: fileUrl(cwd, entry.id), alt: label, loading: "lazy" }),
          inRefs ? h("span", { className: "is-ref-badge is-history-ref-badge" }, t.inReferences) : null,
          h(
            "button",
            {
              type: "button",
              className: "is-history-add",
              title: inRefs ? t.inReferences : t.toReferences,
              "aria-label": inRefs ? t.inReferences : t.toReferences,
              disabled: inRefs,
              onClick: () => onReference(entry),
            },
            "+",
          ),
          h(
            "div",
            { className: "is-history-actions" },
            h(IconAction, { icon: "copy", label: t.copyImage, onClick: () => onCopy(entry) }),
            h(IconAction, { icon: "reveal", label: t.reveal, onClick: () => onReveal(entry) }),
            h(IconAction, { icon: "hide", label: t.hide, onClick: () => onHide(entry) }),
            h(IconAction, { icon: "delete", label: confirming ? t.deleteConfirm : t.delete, onClick: () => onDelete(entry) }),
          ),
        ),
        h("p", { className: "is-history-label", title: label }, label),
      )
    }

    function StudioPanel({ t: fallbackText, close, scope, initialLightbox = "", initialLightboxMissing = false, initialError = "" }) {
      const live = useConfigText(scope, fallbackText)
      const t = live.t
      const lang = live.lang
      const animations = useScopeSnapshot(scope)?.value?.animations !== false
      const [status, setStatus] = React.useState(null)
      const [providerId, setProviderId] = React.useState("")
      const [models, setModels] = React.useState([])
      const [prompt, setPrompt] = React.useState("")
      const [model, setModel] = React.useState("")
      const [modelManual, setModelManual] = React.useState(false)
      const [mode, setMode] = React.useState(() => studioMemory.mode || "exact")
      const [sizeMode, setSizeMode] = React.useState("auto")
      const [longSide, setLongSide] = React.useState(1024)
      const [aspect, setAspect] = React.useState("1:1")
      const [manualWidth, setManualWidth] = React.useState(1024)
      const [manualHeight, setManualHeight] = React.useState(1024)
      const [seedRandom, setSeedRandom] = React.useState(true)
      const [seedInput, setSeedInput] = React.useState("")
      const [promptExtend, setPromptExtend] = React.useState(true)
      const [transparent, setTransparent] = React.useState(false)
      const [refs, setRefs] = React.useState([])
      const [results, setResults] = React.useState(() => studioMemory.entries.slice())
      const [cwd, setCwd] = React.useState("")
      const [busy, setBusy] = React.useState(() => studioMemory.busy)
      const [progress, setProgress] = React.useState(() => ({ ...studioMemory.progress }))
      const [error, setError] = React.useState(initialError)
      const [warning, setWarning] = React.useState("")
      const [hiddenIds, setHiddenIds] = React.useState([])
      const [confirmId, setConfirmId] = React.useState("")
      const [notice, setNotice] = React.useState("")
      const [visibleCount, setVisibleCount] = React.useState(12)
      const [canvasIds, setCanvasIds] = React.useState(() => studioMemory.ids.slice())
      const [canvasRequested, setCanvasRequested] = React.useState(() => studioMemory.requested)
      const [canvasRemoved, setCanvasRemoved] = React.useState(() => studioMemory.removed.slice())
      const [refsOver, setRefsOver] = React.useState(false)
      const [lightboxId, setLightboxId] = React.useState(initialLightbox)
      const lightboxReturnFocus = React.useRef(null)
      const promptRef = React.useRef(null)
      const toastTimer = React.useRef(null)
      const sizes = useFileSizes(results, cwd)
      const saveDir = useScopeSnapshot(scope)?.value?.saveDir || ""
      const dismissKey = dismissedKey(saveDir)

      React.useEffect(() => {
        setHiddenIds(readDismissed(dismissKey))
        setConfirmId("")
        setVisibleCount(12)
      }, [dismissKey])

      React.useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      React.useEffect(() => {
        const sync = () => {
          setCanvasIds(studioMemory.ids.slice())
          setCanvasRequested(studioMemory.requested)
          setCanvasRemoved(studioMemory.removed.slice())
          setBusy(studioMemory.busy)
          setProgress({ ...studioMemory.progress })
          setResults((previous) => mergeResults(previous, studioMemory.entries))
        }
        studioMemory.listeners.add(sync)
        sync()
        return () => studioMemory.listeners.delete(sync)
      }, [])

      React.useEffect(() => {
        const el = promptRef.current
        if (!el) return
        const max = Math.max(104, Math.round((globalThis.innerHeight || 900) * 0.25))
        el.style.height = "auto"
        const next = Math.min(Math.max(el.scrollHeight, 104), max)
        el.style.height = `${next}px`
        el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
      }, [prompt])

      function chooseMode(next) {
        setMode(next)
        studioMemory.mode = next
      }

      function flash(message) {
        if (toastTimer.current) clearTimeout(toastTimer.current)
        setNotice(message)
        toastTimer.current = setTimeout(() => {
          setNotice("")
          toastTimer.current = null
        }, 2000)
      }

      React.useEffect(() => {
        if (!saveDir) return
        if (studioMemory.saveDir && studioMemory.saveDir !== saveDir) {
          studioMemory.ids = []
          studioMemory.requested = 0
          studioMemory.removed = []
          studioMemory.entries = []
          studioMemory.busy = false
          studioMemory.progress = { done: 0, total: 0 }
          studioEmit()
        }
        studioMemory.saveDir = saveDir
        let alive = true
        refreshGallery(cwd)
          .then((entries) => {
            if (!alive) return
            setResults(mergeResults(entries, studioMemory.entries))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [saveDir])
      const providers = Array.isArray(status?.providers) ? status.providers : []
      const hasProvider = providerId.length > 0
      const presetInfo = presetSize(longSide, aspect)
      const manualInfo = manualSize(manualWidth, manualHeight)
      const sizeInfo = sizeMode === "preset" ? presetInfo : sizeMode === "manual" ? manualInfo : { size: "", valid: true }
      const sizeValue = sizeMode === "auto" ? "" : sizeInfo.size
      const seedParsed = parseSeed(seedInput)
      const effectivePromptExtend = transparent ? false : promptExtend
      const seedValid = seedRandom || seedParsed.ok
      const canGenerate =
        hasProvider &&
        prompt.trim().length > 0 &&
        sizeInfo.valid &&
        seedValid &&
        !busy

      async function refreshModels(id) {
        try {
          const result = await postJson(ROUTES.listModels, { providerId: id })
          setModels(Array.isArray(result.models) ? result.models : [])
        } catch {
          setModels([])
        }
      }

      /** Remember or clear one refused model in the profile (never the vault). */
      async function setModelUnavailable(name, unavailable) {
        const row = providers.find((item) => item.id === providerId)
        if (!row || typeof name !== "string" || name.length === 0) return
        const current = Array.isArray(row.unavailableModels) ? row.unavailableModels : []
        const next = withUnavailableModel(current, name, unavailable)
        if (next.length === current.length && next.every((item, index) => item === current[index])) return
        const nextProviders = providers.map((item) =>
          item.id === row.id ? { ...item, unavailableModels: next } : item,
        )
        try {
          await writeConfig(scope, { providers: nextProviders })
          setStatus((previous) => ({
            ...previous,
            providers: (previous?.providers ?? []).map((item) =>
              item.id === row.id ? { ...item, unavailableModels: next } : item,
            ),
          }))
        } catch {
          /* a cache write must never break generation */
        }
      }

      async function refreshGallery(root) {
        try {
          const result = await postJson(ROUTES.listGallery, root ? { cwd: root } : {})
          if (typeof result.cwd === "string" && result.cwd.length > 0) setCwd(result.cwd)
          return Array.isArray(result.entries) ? result.entries : []
        } catch {
          return []
        }
      }

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const result = await postJson(ROUTES.keyStatus, {})
            if (!alive) return
            setStatus(result)
            const active = result.providers?.find((row) => row.id === result.activeProviderId) ?? result.providers?.[0]
            if (active) {
              setProviderId(active.id)
              setModel(active.model ?? "")
              setPromptExtend(result.promptExtend !== false)
              setModels(Array.isArray(active.models) ? active.models : [])
              if (!Array.isArray(active.models) || active.models.length === 0) {
                await refreshModels(active.id)
              }
            }
            const openedCwd = typeof result.cwd === "string" && result.cwd ? result.cwd : result.saveDir || ""
            setCwd(openedCwd)
            const entries = await refreshGallery(openedCwd)
            if (alive) setResults((previous) => mergeResults(previous, entries))
          } catch (failure) {
            if (alive) setError(failure.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      function selectProvider(id) {
        setProviderId(id)
        setModelManual(false)
        const row = providers.find((item) => item.id === id)
        if (row && row.model) setModel(row.model)
        refreshModels(id)
      }

      async function addImageFiles(fileList) {
        const files = Array.from(fileList ?? [])
        const accepted = []
        const maxBytes = Number(status?.imageLimits?.maxImageBytes) || 25 * 1024 * 1024
        const maxMb = Math.max(1, Math.round(maxBytes / (1024 * 1024)))
        for (const file of files) {
          const issue = imageFileIssue(file, maxBytes)
          if (issue === "bad") {
            setError(t.badFile)
            continue
          }
          if (issue === "large") {
            setError(t.fileTooLarge(maxMb))
            continue
          }
          try {
            let data = await readFileAsDataUrl(file)
            const media = imageMediaType(file)
            if (media && !data.startsWith(`data:${media};`)) data = data.replace(/^data:[^;]*/, `data:${media}`)
            if (!data.startsWith("data:image/")) {
              setError(t.badFile)
              continue
            }
            accepted.push({ name: file.name, data })
          } catch (failure) {
            setError(failure.message)
          }
        }
        if (accepted.length === 0) return
        setError("")
        if (refs.length + accepted.length > 10) {
          setError(t.limit)
          return
        }
        setRefs((previous) => [...previous, ...accepted])
      }

      function addFiles(event) {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ""
        addImageFiles(files)
      }

      function pastedImageFiles(event) {
        const items = Array.from(event.clipboardData?.items ?? [])
        return items
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file) => Boolean(file) && isImageFile(file))
      }

      function handlePaste(event) {
        const files = pastedImageFiles(event)
        if (files.length === 0) return
        event.preventDefault()
        addImageFiles(files)
      }

      function handleRefDrop(event) {
        event.preventDefault()
        setRefsOver(false)
        const transfer = event.dataTransfer
        const id =
          transfer.getData("application/x-dsh-q-image-studio-id") || transfer.getData("text/plain")
        const entry = id ? results.find((row) => row.id === id) : null
        if (entry) {
          addEntryReference(entry)
          return
        }
        if (transfer.files?.length) addImageFiles(transfer.files)
      }

      function dragHasRefs(event) {
        const types = Array.from(event.dataTransfer?.types ?? [])
        return (
          types.includes("Files") ||
          types.includes("application/x-dsh-q-image-studio-id") ||
          types.includes("text/plain")
        )
      }

      async function requestOne(seed) {
        const requestSeed = Number.isInteger(seed) ? seed : randomSeed()
        const request = buildPanelRequest({
          providerId,
          prompt,
          model,
          size: sizeValue,
          seed: requestSeed,
          promptExtend: effectivePromptExtend,
          transparent,
          references: refs.map((row) => ({ data: row.data })),
          cwd,
        })
        const hit = await postJson(ROUTES.generate, request)
        if (!hit?.ok) {
          const message = hit?.error || t.failed
          if (modelIssueFromFailure(message)) await setModelUnavailable(model, true)
          throw new Error(message)
        }
        await setModelUnavailable(model, false)
        const entries = await refreshGallery(hit.cwd || cwd)
        const names = new Set((hit.files ?? []).map(baseName))
        const matched = entries.filter((entry) => names.has(baseName(entry.file)))
        const incoming = matched.length > 0 ? matched : entries.slice(0, Number(hit.files?.length) || 1)
        return { hit, entries: incoming }
      }

      async function generate() {
        if (prompt.trim().length === 0) {
          setError(t.needPrompt)
          return
        }
        if (!canGenerate) {
          setError(sizeInfo.valid ? t.seedInvalid : sizeInfo.reason)
          return
        }
        const generationMode = mode
        const requested = generationMode === "vibe" ? VIBE_COUNT : 1
        studioMemory.ids = []
        studioMemory.requested = requested
        studioMemory.removed = []
        studioMemory.busy = true
        studioMemory.progress = { done: 0, total: requested }
        studioMemory.mode = generationMode
        studioMemory.saveDir = saveDir || studioMemory.saveDir
        studioEmit()
        setError("")
        setWarning("")
        setNotice("")
        try {
          if (generationMode === "vibe") {
            const total = VIBE_COUNT
            setProgress({ done: 0, total })
            let lastFailure = null
            const outcome = await runVibe({
              count: total,
              run: () => requestOne(randomSeed()),
              onResult: ({ hit, entries }) => {
                if (entries.length > 0) {
                  studioRememberEntries(entries)
                  studioMemory.ids = [...studioMemory.ids, ...entries.map((row) => row.id)].slice(0, VIBE_COUNT)
                  studioEmit()
                }
                const transparencyWarning = alphaWarningText(hit, t)
                if (transparencyWarning) setWarning(transparencyWarning)
              },
              onProgress: (done, all) => {
                studioMemory.progress = { done, total: all }
                studioEmit()
              },
              onError: (failure) => {
                lastFailure = failure
              },
            })
            if (outcome.failed === total) setError(lastFailure?.message ?? t.failed)
            else if (outcome.failed > 0) setWarning(t.failed + `: ${outcome.failed}/${total}`)
          } else {
            const seed = seedRandom ? randomSeed() : seedParsed.value
            const { hit, entries } = await requestOne(seed)
            if (entries.length > 0) {
              studioRememberEntries(entries)
              studioMemory.ids = entries.map((row) => row.id)
              studioEmit()
            }
            const transparencyWarning = alphaWarningText(hit, t)
            if (transparencyWarning) setWarning(transparencyWarning)
          }
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        } finally {
          studioMemory.busy = false
          studioEmit()
          setRefs([])
        }
      }

      function hideEntry(entry) {
        setHiddenIds((previous) => {
          const next = previous.includes(entry.id) ? previous : [...previous, entry.id]
          writeDismissed(dismissKey, next)
          return next
        })
        setConfirmId("")
        studioMemory.ids = studioMemory.ids.filter((id) => id !== entry.id)
        studioEmit()
        if (lightboxId === entry.id) setLightboxId("")
      }

      function showHidden() {
        writeDismissed(dismissKey, [])
        setHiddenIds([])
      }

      function openLightbox(entry) {
        lightboxReturnFocus.current = globalThis.document?.activeElement ?? null
        setNotice("")
        setError("")
        setLightboxId(entry.id)
      }

      function closeLightbox() {
        setLightboxId("")
      }

      function applyLightbox(entry) {
        useEntrySettings(entry)
        closeLightbox()
      }

      function copyEntry(entry) {
        setNotice("")
        setError("")
        return copyImageEntry({
          entry,
          copy: (item) => postJson(ROUTES.copy, { cwd, id: item.id }),
          flash,
          fail: setError,
          t,
        })
      }

      /** Read a gallery file back into a data URL for references/develop. */
      async function entryDataUrl(entry) {
        const response = await fetch(fileUrl(cwd, entry.id), { credentials: "same-origin" })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return readFileAsDataUrl(await response.blob())
      }

      function applyEntrySize(entry) {
        const match = /^(\d+)x(\d+)$/i.exec(String(entry.size ?? ""))
        if (!match) {
          setSizeMode("auto")
          return
        }
        setSizeMode("manual")
        setManualWidth(Number(match[1]))
        setManualHeight(Number(match[2]))
      }

      function useEntrySettings(entry) {
        setPrompt(entry.prompt ?? entry.finalPrompt ?? "")
        if (entry.model) setModel(entry.model)
        applyEntrySize(entry)
        setTransparent(entry.transparent === true)
        setPromptExtend(entry.promptExtend !== false)
        setSeedRandom(false)
        setSeedInput(entry.seed === undefined || entry.seed === null ? "" : String(entry.seed))
        setError("")
      }

      async function developEntry(entry) {
        setError("")
        try {
          const data = await entryDataUrl(entry)
          const row = { name: entry.id, data, entryId: entry.id }
          setRefs((previous) =>
            previous.some((item) => item.entryId === entry.id) ? previous : [...previous, row].slice(0, 10),
          )
          setPrompt(entry.prompt ?? entry.finalPrompt ?? "")
          if (entry.model) setModel(entry.model)
          applyEntrySize(entry)
          chooseMode("exact")
          setTransparent(entry.transparent === true)
          setPromptExtend(entry.promptExtend !== false)
          if (entry.seed !== undefined && entry.seed !== null) {
            setSeedRandom(false)
            setSeedInput(String(entry.seed))
          } else {
            setSeedRandom(true)
            setSeedInput("")
          }
          globalThis.requestAnimationFrame?.(() => promptRef.current?.focus())
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        }
      }

      async function addEntryReference(entry) {
        if (refs.some((item) => item.entryId === entry.id)) return
        if (refs.length >= 10) {
          setError(t.limit)
          return
        }
        setError("")
        try {
          const data = await entryDataUrl(entry)
          setRefs((previous) =>
            previous.some((item) => item.entryId === entry.id)
              ? previous
              : [...previous, { name: entry.id, data, entryId: entry.id }].slice(0, 10),
          )
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        }
      }

      async function revealEntry(entry) {
        setNotice("")
        try {
          const result = await postJson(ROUTES.reveal, { cwd, id: entry.id })
          if (!result?.ok) throw new Error(result?.error || t.failed)
          setNotice(t.revealed)
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        }
      }

      async function deleteEntry(entry) {
        if (confirmId !== entry.id) {
          setConfirmId(entry.id)
          setNotice(t.confirmDelete)
          return
        }
        setNotice("")
        setError("")
        try {
          const result = await postJson(ROUTES.deleteImage, { cwd, id: entry.id })
          if (!result?.ok) throw new Error(result?.error || t.failed)
          setResults((previous) => previous.filter((row) => row.id !== entry.id))
          setHiddenIds((previous) => previous.filter((id) => id !== entry.id))
          studioMemory.entries = studioMemory.entries.filter((row) => row.id !== entry.id)
          if (studioMemory.ids.includes(entry.id) && !studioMemory.removed.includes(entry.id)) {
            studioMemory.removed = [...studioMemory.removed, entry.id]
          }
          studioEmit()
          setConfirmId("")
          if (lightboxId === entry.id) setLightboxId("")
          const entries = await refreshGallery(cwd)
          if (entries.length > 0) setResults(mergeResults(entries, studioMemory.entries))
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        }
      }

      function navigateLightbox(delta) {
        if (visibleResults.length === 0) return
        const current = Math.max(0, visibleResults.findIndex((entry) => entry.id === lightboxId))
        const next = (current + delta + visibleResults.length) % visibleResults.length
        setLightboxId(visibleResults[next].id)
      }

      async function removeLightboxEntry(entry) {
        const remaining = visibleResults.filter((row) => row.id !== entry.id)
        const at = Math.max(0, visibleResults.findIndex((row) => row.id === entry.id))
        try {
          const result = await postJson(ROUTES.deleteImage, { cwd, id: entry.id })
          if (!result?.ok) throw new Error(result?.error || t.failed)
          setResults((previous) => previous.filter((row) => row.id !== entry.id))
          setHiddenIds((previous) => previous.filter((id) => id !== entry.id))
          studioMemory.entries = studioMemory.entries.filter((row) => row.id !== entry.id)
          if (studioMemory.ids.includes(entry.id) && !studioMemory.removed.includes(entry.id)) {
            studioMemory.removed = [...studioMemory.removed, entry.id]
          }
          studioEmit()
          setLightboxId(remaining.length > 0 ? remaining[Math.min(at, remaining.length - 1)].id : "")
        } catch (failure) {
          setError(failure?.message ?? t.failed)
        }
      }

      const activeProvider = providers.find((row) => row.id === providerId) ?? providers[0]
      const verifiedModels = Array.isArray(activeProvider?.models) ? activeProvider.models : models
      const modelOptions = []
      for (const name of [model, ...(Array.isArray(verifiedModels) ? verifiedModels : [])]) {
        const value = String(name ?? "").trim()
        if (value.length > 0 && !modelOptions.includes(value)) modelOptions.push(value)
      }
      const modelVerified = Boolean(activeProvider?.verifiedAt)
      const failure = error ? describeFailure(error, t, model) : ""
      const visibleResults = results.filter((entry) => !hiddenIds.includes(entry.id))
      const lightboxEntry = lightboxId ? visibleResults.find((entry) => entry.id === lightboxId) ?? null : null
      const lightboxIndex = lightboxEntry ? Math.max(0, visibleResults.findIndex((entry) => entry.id === lightboxEntry.id)) : 0
      const shownResults = visibleResults.slice(0, visibleCount)
      const groups = groupByDay(shownResults, lang)
      const canvasEntries = canvasIds.map((id) => visibleResults.find((entry) => entry.id === id) ?? null)
      const canvasSlots = canvasSlotCount({ busy, requested: canvasRequested, ids: canvasIds })
      const canvasIsGrid = canvasSlots > 1
      const canvasPrimary = canvasEntries.find(Boolean) ?? null
      const canvasSeed = canvasPrimary?.seed
      const canvasBytes = canvasPrimary ? sizes[canvasPrimary.id] : undefined
      const canvasMeta = canvasPrimary
        ? [
            canvasPrimary.model,
            canvasPrimary.size,
            canvasSeed === undefined ? "" : `${t.seed} ${canvasSeed}`,
            formatTime(canvasPrimary.createdAt, lang),
            typeof canvasBytes === "number" ? formatFileSize(canvasBytes, lang) : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : ""

      return h(
        "div",
        { className: panelClass(animations, busy), onPaste: handlePaste },
        h(
          "aside",
          { className: "is-page-side" },
          h(
            "div",
            { className: "is-page-brand" },
            h("span", { className: "is-brand-mark" }, h(SidebarGlyph, { size: 24, plain: true })),
            h("h1", { className: "is-page-title" }, t.title),
          ),
          h(
            "form",
            {
              className: "is-form is-page-form",
              "aria-busy": busy ? "true" : undefined,
              onSubmit: (event) => {
                event.preventDefault()
                generate()
              },
            },
            h(
              "div",
              { className: "is-mode-row" },
              h(
                "div",
                { className: "is-mode", role: "group", "aria-label": t.modeExact },
                h(
                  "button",
                  {
                    type: "button",
                    className: `is-mode-btn${mode === "exact" ? " is-active" : ""}`,
                    "aria-pressed": mode === "exact",
                    onClick: () => chooseMode("exact"),
                  },
                  t.modeExact,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `is-mode-btn${mode === "vibe" ? " is-active" : ""}`,
                    "aria-pressed": mode === "vibe",
                    onClick: () => chooseMode("vibe"),
                  },
                  `${t.modeVibe} · ${VIBE_COUNT}`,
                ),
              ),
              mode === "vibe" ? h("p", { className: "is-hint is-mode-hint" }, t.vibeCount) : null,
            ),
            busy && progress.total > 0
              ? h(
                  "p",
                  { className: "is-hint", role: "status" },
                  String(t.vibeProgress)
                    .replace("{done}", String(progress.done))
                    .replace("{total}", String(progress.total)),
                )
              : null,
            h(
              "div",
              { className: "is-connect" },
              h(
                "div",
                { className: "is-fieldset" },
                h(
                  "label",
                  { className: "is-label", htmlFor: "dsh-q-image-studio-profile" },
                  h("span", null, t.profile),
                ),
                h(Dropdown, {
                  id: "dsh-q-image-studio-profile",
                  value: providerId,
                  options: providers.map((row) => ({ value: row.id, label: row.label || t.profile })),
                  disabled: providers.length === 0,
                  onChange: selectProvider,
                  placeholder: t.profile,
                  ariaLabel: t.profile,
                }),
                providers.length === 0 ? h("span", { className: "is-hint" }, t.noProvider) : null,
              ),
              h(
                "div",
                { className: "is-fieldset" },
                h("label", { className: "is-label", htmlFor: "dsh-q-image-studio-model" }, h("span", null, t.model)),
                modelManual
                  ? h("input", {
                      id: "dsh-q-image-studio-model",
                      className: "is-input",
                      value: model,
                      placeholder: PLACEHOLDER_MODEL,
                      onChange: (event) => setModel(event.target.value),
                    })
                  : h(Dropdown, {
                      id: "dsh-q-image-studio-model",
                      value: model,
                      options: modelOptions.map((name) => ({
                        value: name,
                        label: modelOptionLabel(name, activeProvider?.unavailableModels, t),
                      })),
                      disabled: !modelVerified,
                      placeholder: modelVerified ? t.chooseModel : t.verifyInSettings,
                      onChange: (next) => setModel(next),
                      ariaLabel: t.model,
                      manual: modelVerified
                        ? { label: t.enterManually, onSelect: () => setModelManual(true) }
                        : null,
                    }),
                !modelVerified
                  ? h("span", { className: "is-hint" }, t.verifyInSettings)
                  : modelManual
                    ? h(
                        "button",
                        { type: "button", className: "is-link", onClick: () => setModelManual(false) },
                        t.useList,
                      )
                    : null,
              ),
            ),
            h(
              "div",
              { className: "is-fieldset is-prompt-field" },
              h(
                "div",
                { className: "is-label is-prompt-head" },
                h("label", { htmlFor: "dsh-q-image-studio-prompt" }, t.prompt),
                h(GuidePopover, { t, lang, animations }),
              ),
              h(
                "div",
                { className: "is-prompt-box" },
                h("textarea", {
                  ref: promptRef,
                  id: "dsh-q-image-studio-prompt",
                  className: "is-textarea is-prompt is-page-prompt",
                  rows: 3,
                  maxLength: 2000,
                  value: prompt,
                  placeholder: t.promptPlaceholder,
                  onChange: (event) => setPrompt(event.target.value),
                }),
                h(
                  "div",
                  { className: "is-prompt-meta" },
                  h("span", null, `${prompt.length} / 2000`),
                ),
              ),
            ),
            h(
              "div",
              { className: "is-fieldset is-size" },
              h(
                "div",
                { className: "is-size-controls" },
                h("span", { className: "is-label is-size-label" }, t.sizeMode),
                h(
                  "div",
                  { className: "is-seg", role: "group", "aria-label": t.sizeMode },
                  SIZE_MODES.map((value) =>
                    h(
                      "button",
                      {
                        key: value,
                        type: "button",
                        className: `is-seg-btn${sizeMode === value ? " is-active" : ""}`,
                        "aria-pressed": sizeMode === value,
                        onClick: () => setSizeMode(value),
                      },
                      value === "auto" ? t.sizeAuto : value === "preset" ? t.sizePreset : t.sizeManual,
                    ),
                  ),
                ),
                sizeMode === "preset"
                  ? h(Dropdown, {
                      id: "dsh-q-image-studio-long-side",
                      value: longSide,
                      options: LONG_SIDES.map((value) => ({ value, label: `${value} px` })),
                      onChange: (next) => setLongSide(Number(next)),
                      ariaLabel: t.longSide,
                    })
                  : null,
                sizeMode === "preset"
                  ? h(
                      "div",
                      { className: "is-chips" },
                      ASPECTS.map((value) => {
                        const info = presetSize(longSide, value)
                        return h(
                          "button",
                          {
                            key: value,
                            type: "button",
                            className: `is-chip${aspect === value ? " is-active" : ""}`,
                            "aria-pressed": aspect === value,
                            disabled: !info.valid,
                            title: info.valid ? `${info.size} · ${formatPixels(info.pixels, lang)} px` : info.reason,
                            onClick: () => setAspect(value),
                          },
                          value,
                        )
                      }),
                    )
                  : null,
                sizeMode === "preset"
                  ? h(
                      "p",
                      {
                        className: `is-hint is-size-hint${presetInfo.valid ? "" : " is-error"}`,
                        title: presetInfo.valid
                          ? `${presetInfo.size} · ${formatPixels(presetInfo.pixels, lang)} px · ${presetInfo.pixels > MAX_AREA ? t.tariffHigh : t.tariffBase}`
                          : presetInfo.reason,
                      },
                      presetInfo.valid
                        ? `${presetInfo.size} · ${formatPixels(presetInfo.pixels, lang)} px · ${presetInfo.pixels > MAX_AREA ? t.tariffHigh : t.tariffBase}`
                        : presetInfo.reason,
                    )
                  : null,
              ),
              sizeMode === "auto" ? h("p", { className: "is-hint is-size-hint" }, t.sizeAutoHint) : null,
              sizeMode === "manual"
                ? h(
                    "div",
                    { className: "is-manual" },
                    h(
                      "div",
                      { className: "is-manual-row" },
                      h("label", { className: "is-label", htmlFor: "dsh-q-image-studio-width" }, t.width),
                      h("input", {
                        id: "dsh-q-image-studio-width",
                        className: "is-range",
                        type: "range",
                        min: MANUAL_MIN,
                        max: MANUAL_MAX,
                        step: MANUAL_STEP,
                        value: manualWidth,
                        onChange: (event) => setManualWidth(Number(event.target.value)),
                      }),
                      h("input", {
                        className: "is-input is-num",
                        type: "number",
                        min: MANUAL_MIN,
                        max: MANUAL_MAX,
                        step: MANUAL_STEP,
                        value: manualWidth,
                        onChange: (event) => setManualWidth(Number(event.target.value)),
                      }),
                    ),
                    h(
                      "div",
                      { className: "is-manual-row" },
                      h("label", { className: "is-label", htmlFor: "dsh-q-image-studio-height" }, t.height),
                      h("input", {
                        id: "dsh-q-image-studio-height",
                        className: "is-range",
                        type: "range",
                        min: MANUAL_MIN,
                        max: MANUAL_MAX,
                        step: MANUAL_STEP,
                        value: manualHeight,
                        onChange: (event) => setManualHeight(Number(event.target.value)),
                      }),
                      h("input", {
                        className: "is-input is-num",
                        type: "number",
                        min: MANUAL_MIN,
                        max: MANUAL_MAX,
                        step: MANUAL_STEP,
                        value: manualHeight,
                        onChange: (event) => setManualHeight(Number(event.target.value)),
                      }),
                    ),
                    h(
                      "p",
                      { className: `is-hint${manualInfo.valid ? "" : " is-error"}` },
                      manualInfo.valid
                        ? `${manualInfo.size} · ${formatPixels(manualInfo.pixels, lang)} px`
                        : manualInfo.reason,
                    ),
                  )
                : null,
            ),
            h(
              "div",
              { className: "is-fieldset" },
              h(
                "div",
                { className: "is-seed-row" },
                h(
                  "label",
                  { className: "is-check" },
                  h("input", {
                    type: "checkbox",
                    checked: seedRandom,
                    onChange: (event) => {
                      setSeedRandom(event.target.checked)
                      if (event.target.checked) setPromptExtend(true)
                    },
                  }),
                  t.seedRandom,
                ),
                h("span", { className: "is-label" }, t.seed),
                h("input", {
                  className: "is-input is-seed",
                  type: "number",
                  inputMode: "numeric",
                  min: 0,
                  max: MAX_SEED,
                  step: 1,
                  value: seedRandom ? "" : seedInput,
                  placeholder: seedRandom ? "—" : "0…2147483647",
                  disabled: seedRandom,
                  onChange: (event) => {
                    setSeedInput(event.target.value)
                    if (parseSeed(event.target.value).ok) setPromptExtend(false)
                  },
                }),
                h(
                  "label",
                  { className: "is-check" },
                  h("input", {
                    type: "checkbox",
                    checked: transparent,
                    onChange: (event) => setTransparent(event.target.checked),
                  }),
                  t.transparent,
                ),
              ),
              !seedRandom && !seedParsed.ok && seedInput.length > 0
                ? h("p", { className: "is-hint is-error" }, t.seedInvalid)
                : null,
              transparent
                ? h("p", { className: "is-hint is-transparent-hint" }, t.extendTransparent)
                : !seedRandom && seedParsed.ok && !promptExtend
                  ? h(
                      "p",
                      { className: "is-hint" },
                      `${t.extendOff} · `,
                      h("button", { type: "button", className: "is-link", onClick: () => setPromptExtend(true) }, t.extendReturn),
                    )
                  : null,
            ),
            h(
              "div",
              {
                className: `is-ref-zone${refsOver ? " is-over" : ""}`,
                onDragEnter: (event) => {
                  if (dragHasRefs(event)) {
                    event.preventDefault()
                    setRefsOver(true)
                  }
                },
                onDragOver: (event) => {
                  if (dragHasRefs(event)) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "copy"
                    setRefsOver(true)
                  }
                },
                onDragLeave: (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setRefsOver(false)
                },
                onDrop: handleRefDrop,
              },
              h(
                "div",
                { className: "is-ref-head" },
                h("span", { className: "is-label" }, `${t.references} · ${refs.length}`),
                h("span", { className: "is-hint" }, t.dragRefs),
              ),
              h(
                "div",
                { className: "is-ref-list" },
                refs.map((row, index) =>
                  h(
                    "div",
                    { className: "is-ref-thumb", key: `${row.entryId ?? row.name}-${index}` },
                    h("img", { src: row.data, alt: row.name }),
                    h(
                      "button",
                      {
                        type: "button",
                        "aria-label": `${t.removeRef}: ${row.name}`,
                        title: t.removeRef,
                        onClick: () => setRefs((previous) => previous.filter((_, at) => at !== index)),
                      },
                      "×",
                    ),
                  ),
                ),
                h(
                  "label",
                  { className: "is-ref-add", title: t.addFiles, "aria-label": t.addFiles },
                  "+",
                  h("input", {
                    className: "is-file-input",
                    type: "file",
                    accept: "image/*",
                    multiple: true,
                    onChange: addFiles,
                  }),
                ),
              ),
            ),
            h(
              "div",
              { className: "is-actions is-page-actions" },
              h(
                "button",
                {
                  type: "submit",
                  className: "is-btn is-generate",
                  "data-busy": busy ? "true" : undefined,
                  disabled: busy || !hasProvider || !sizeInfo.valid || !seedValid || prompt.trim().length === 0,
                },
                busy
                  ? t.generating
                  : (() => {
                      const label = generateLabels(mode, t)
                      return h(
                        "span",
                        null,
                        h("span", { className: "is-gen-full" }, label.full),
                        h("span", { className: "is-gen-short" }, label.short),
                      )
                    })(),
              ),
            ),
          ),
          failure ? h(ErrorAlert, { message: failure, t }) : null,
          warning ? h("p", { className: "is-warning-box", role: "status" }, warning) : null,
        ),
        h(
          "main",
          { className: "is-page-main" },
          h(
            "section",
            { className: "is-canvas-panel", "aria-label": t.result },
            h(
              "header",
              { className: "is-canvas-head" },
              h(
                "div",
                { className: "is-canvas-heading" },
                h("h2", { className: "is-canvas-title" }, t.result),
                canvasPrimary?.size || canvasPrimary?.model
                  ? h(
                      "span",
                      { className: "is-canvas-chip" },
                      [canvasPrimary.size, canvasPrimary.model].filter(Boolean).join(" · "),
                    )
                  : null,
              ),
              canvasSeed === undefined
                ? null
                : h("span", { className: "is-canvas-seed" }, `${t.seed} ${canvasSeed}`),
            ),
            h(
              "div",
              { className: "is-canvas-stage" },
              canvasSlots === 0
                ? h("p", { className: "is-canvas-empty" }, t.canvasEmpty)
                : h(
                    "div",
                    { className: `is-canvas-media${canvasIsGrid ? " is-canvas-grid" : ""}` },
                    Array.from({ length: Math.max(canvasSlots, 1) }).map((_, index) => {
                      const id = canvasIds[index]
                      const entry = id ? visibleResults.find((row) => row.id === id) ?? null : null
                      if (entry) {
                        return h(
                          "div",
                          { className: "is-canvas-cell", key: entry.id },
                          h(
                            "div",
                            { className: "is-canvas-frame", style: { "--ar": String(entryAspect(entry)) } },
                          h(
                            "button",
                            {
                              type: "button",
                              className: "is-canvas-tile is-clickable",
                              "aria-label": entry.prompt || entry.id,
                              onClick: () => openLightbox(entry),
                            },
                            h("img", { src: fileUrl(cwd, entry.id), alt: entry.prompt || entry.id }),
                          ),
                          h(
                            "div",
                            { className: "is-tile-actions" },
                            h(IconAction, { key: "copy", icon: "copy", label: t.copyImage, onClick: () => copyEntry(entry) }),
                            h(IconAction, { key: "reveal", icon: "reveal", label: t.reveal, onClick: () => revealEntry(entry) }),
                            h(IconAction, { key: "hide", icon: "hide", label: t.hide, onClick: () => hideEntry(entry) }),
                            h(IconAction, {
                              key: "delete",
                              icon: "delete",
                              label: confirmId === entry.id ? t.deleteConfirm : t.delete,
                              onClick: () => deleteEntry(entry),
                              className: confirmId === entry.id ? "is-danger" : undefined,
                            }),
                          ),
                          ),
                        )
                      }
                      if (id) {
                        return h(
                          "div",
                          { className: "is-canvas-tile is-removed", key: id },
                          h("span", null, canvasRemoved.includes(id) ? t.deletedTile : t.canvasEmpty),
                        )
                      }
                      return h(
                        "div",
                        { className: "is-canvas-tile", key: `slot-${index}` },
                        h(
                          "div",
                          { className: "is-canvas-placeholder" },
                          h("span", { className: "is-dots" }, h("span"), h("span"), h("span")),
                        ),
                      )
                    }),
                  ),
            ),
            h(
              "footer",
              { className: "is-canvas-foot" },
              h("span", { className: "is-canvas-meta" }, canvasMeta),
            ),
          ),
          h(
            "section",
            { className: "is-history-panel", "aria-label": t.history },
            h(
              "header",
              { className: "is-history-head" },
              h("div", { className: "is-history-heading" },
                h("h2", { className: "is-history-title" }, t.history),
                h("span", { className: "is-count" }, String(visibleResults.length)),
              ),
              h(
                "span",
                { className: "is-hint is-history-help" },
                hiddenIds.length > 0
                  ? h(
                      "span",
                      null,
                      `${t.hidden}: ${hiddenIds.length} · `,
                      h("button", { type: "button", className: "is-link", onClick: showHidden }, t.showHidden),
                    )
                  : t.historyHint,
              ),
            ),
            visibleResults.length === 0
              ? h("p", { className: "is-empty" }, results.length > 0 ? t.allHidden : t.empty)
              : h(
                  "div",
                  { className: "is-history-scroll" },
                  groups.map((group) =>
                    h(
                      "section",
                      { className: "is-history-group", key: group.label },
                      h("h4", { className: "is-history-day" }, group.label),
                      h(
                        "div",
                        { className: "is-history-row" },
                        group.entries.map((entry) =>
                          h(HistoryCard, {
                            key: entry.id,
                            entry,
                            cwd,
                            t,
                            lang,
                            confirming: confirmId === entry.id,
                            inRefs: refs.some((row) => row.entryId === entry.id),
                            onOpen: openLightbox,
                            onCopy: copyEntry,
                            onHide: hideEntry,
                            onDelete: deleteEntry,
                            onReveal: revealEntry,
                            onReference: addEntryReference,
                          }),
                        ),
                      ),
                    ),
                  ),
                  visibleResults.length > visibleCount
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "is-btn is-show-more",
                          onClick: () => setVisibleCount((count) => count + 12),
                        },
                        t.showMore,
                      )
                    : null,
                ),
          ),
        ),
        notice ? h("div", { className: "is-page-toast", role: "status" }, notice) : null,
        lightboxEntry
          ? h(Lightbox, {
              key: lightboxEntry.id,
              entry: lightboxEntry,
              cwd,
              t,
              lang,
              animations,
              inRefs: refs.some((row) => row.entryId === lightboxEntry.id),
              index: lightboxIndex,
              total: visibleResults.length,
              onClose: closeLightbox,
              onNavigate: navigateLightbox,
              onUse: applyLightbox,
              onReference: addEntryReference,
              onReveal: revealEntry,
              onRemove: removeLightboxEntry,
              returnFocusRef: lightboxReturnFocus,
              initialMissing: initialLightboxMissing,
            })
          : null,
      )
    }

    function SidebarGlyph({ size, plain = false }) {
      const px = size ?? 18
      const image = h("img", {
        className: "is-k8-icon",
        src: "/plugins/dsh-q-image-studio/icon",
        width: px,
        height: px,
        alt: "",
        "aria-hidden": "true",
        draggable: false,
      })
      if (plain) return image
      return h(
        "span",
        { className: "is-k8-plate", style: { width: px, height: px } },
        image,
      )
    }

    function injectStyles() {
      if (document.querySelector('style[data-plugin="dsh-q-image-studio"]')) return
      const style = document.createElement("style")
      style.dataset.plugin = "dsh-q-image-studio"
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    function apply(ctx) {
      const t = TEXT.en
      const scope = createSettingsScopeStore(ctx)
      const close = () => ctx.get?.("layout")?.selectPanel(null)

      ctx.effect(() => injectStyles(), "dsh-q-image-studio: styles")

      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: CONFIG_SLOT_KEY, inject: () => ({ scope, t }) },
          SettingsCardShell,
        ),
      )

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: SIDEBAR_ID, inject: () => ({ t, close, scope }) }, StudioPanel),
      )

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: SIDEBAR_ID,
            order: 20,
            label: () => text(scope?.getSnapshot?.()?.value?.language).title,
            inject: () => ({ t }),
          },
          SidebarGlyph,
        ),
      )
    }

    return {
      name: "@u-cha/dsh-q-image-studio/client",
      inject: ["slots"],
      apply,
      __test: {
        newProfile,
        buildPanelRequest,
        changeSaveDir,
        presetSize,
        manualSize,
        parseSeed,
        randomSeed,
        transparentPromptText,
        alphaWarningText,
        runVibe,
        VIBE_COUNT,
        normalizeSaveDir,
        mergeResults,
        describeRejection,
        writeConfig,
        resolveSettingsScope,
        Dropdown,
        dropdownUp,
        modelsLabel,
        profileName,
        deleteClickDecision,
        deleteProfileWithKey,
        DELETE_CONFIRM_MS,
        createSettingsScopeStore,
        DEGRADED_SCOPE,
        SettingsCardShell,
        SettingsErrorBoundary,
        ProfileDeleteButton,
        SaveNote,
        CardFailure,
        formatFileSize,
        describeFailure,
        parseProviderFailure,
        modelIssueFromFailure,
        withUnavailableModel,
        modelOptionLabel,
        groupByDay,
        guidePlainText,
        copyImageEntry,
        generateLabels,
        GuidePopover,
        ErrorAlert,
        HistoryCard,
        Lightbox,
        displayPath,
        entryDimensions,
        entryAspect,
        extendLabel,
        ResultCard,
        SettingsCard,
        StudioPanel,
        panelClass,
        TEXT,
        STYLE,
        dismissedKey,
        readDismissed,
        writeDismissed,
        studioMemory,
        SidebarGlyph,
        canvasSlotCount,
        isImageFile,
        imageFileIssue,
        imageMediaType,
      },
    }
  },
})
