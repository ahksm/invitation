/**
 * Патчи к web/support.js (рантайм .dc.html из Claude Design). Сам файл не правится, чтобы новую
 * версию дизайна можно было положить как есть: сервер накладывает патчи при сборке. Каждый патч
 * заменяет точный фрагмент оригинала; если фрагмента нет или он встречается дважды, сборка
 * падает при старте, и патчи нужно сверить с новым рантаймом.
 *
 * Помеченные [invito] комментарии попадают в отдаваемый /app/support.js.
 */
export type Patch = { why: string; find: string; replace: string };

export function applyPatches(src: string, patches: readonly Patch[]): string {
  for (const p of patches) {
    const at = src.indexOf(p.find);
    if (at < 0) throw new Error(`web/support.js: патч «${p.why}» не применился, фрагмент не найден`);
    if (src.indexOf(p.find, at + 1) >= 0) throw new Error(`web/support.js: патч «${p.why}» не применился, фрагмент встречается больше одного раза`);
    // Без String.replace: в коде замены могут быть символы $.
    src = src.slice(0, at) + p.replace + src.slice(at + p.find.length);
  }
  return src;
}

// Тире в сообщениях support.js записано escape-последовательностью (шесть символов), а не самим символом.
const EM_DASH = "\\u2014";

export const supportPatches: readonly Patch[] = [
  {
    why: "логика из window.__dcLogic вместо new Function",
    find: String.raw`  function evalDcLogic(src) {
    //! nosemgrep: eval-and-function-constructor
    const fn = new Function(
      "DCLogic",
      "StreamableLogic",
      "React",
      src + '\n;return (typeof Component!=="undefined"&&Component)||undefined;'
    );
    return fn(StreamableLogic, StreamableLogic, getReact());
  }`,
    replace: String.raw`  // [invito] Логика собрана сервером в /app/dc-bundle.js обычной функцией, поэтому new Function
  // (и 'unsafe-eval' в CSP) не нужен. В js у разобранного DC лежит его имя (см. dcSource).
  function evalDcLogic(name) {
    const make = window.__dcLogic && Object.hasOwn(window.__dcLogic, name) ? window.__dcLogic[name] : null;
    if (typeof make !== "function") throw new Error("no logic for " + name + " in dc-bundle.js");
    return make(StreamableLogic, StreamableLogic, getReact());
  }
  // [invito] DC из /app/dc-bundle.js в том виде, в каком его возвращает parseDcText: шаблон —
  // сырой текст из <x-dc>, поэтому compileTemplate/encodeCase видят его как при загрузке файла.
  function dcSource(name) {
    const src = window.__dcSources && Object.hasOwn(window.__dcSources, name) ? window.__dcSources[name] : null;
    if (!src) return null;
    const hasLogic = !!window.__dcLogic && Object.hasOwn(window.__dcLogic, name);
    return { template: src.template, js: hasLogic ? name : "", props: src.props || null, preview: src.preview || null };
  }`,
  },
  {
    why: "корневой DC из window.__dcSources без fetch(location.href)",
    find: String.raw`    const parsed = parseDcDocument(doc);
    if (!parsed) return null;
    const React = getReact();
    const rootName = rootNameForDocument(doc, location);
    runtime.markFetched(rootName);
    runtime.setRootName(rootName);
    runtime.adoptParsed(rootName, parsed);
    if (!window.__resources) {
      fetch(location.href).then((res) => res.ok ? res.text() : "").then((t) => {
        const raw = t ? parseDcText(t) : null;
        if (raw?.template) runtime.updateHtml(rootName, raw.template);
      }).catch(() => {
      });
    }
`,
    replace: String.raw`    // [invito] Корневой DC (window.__dcRoot) берётся из /app/dc-bundle.js. Его сырой шаблон сразу
    // идёт в updateHtml, как в оригинале после повторной загрузки страницы, так что camelCase-атрибуты
    // и <sc-for> внутри <select> работают с первого кадра. <x-dc> в оболочке — только точка монтирования.
    if (!doc.querySelector("x-dc")) return null;
    const rootName = window.__dcRoot;
    const parsed = rootName ? dcSource(rootName) : null;
    if (!parsed) {
      // [invito] Без бандла (не загрузился или упал при выполнении) рисовать нечего: страница пустая, причина в консоли.
      console.error("[invito] /app/dc-bundle.js did not load or failed: no source for the root DC " + JSON.stringify(rootName) + ", nothing to render.");
      return null;
    }
    const React = getReact();
    runtime.markFetched(rootName);
    runtime.setRootName(rootName);
    runtime.adoptParsed(rootName, parsed);
`,
  },
  {
    why: "вложенные DC из window.__dcSources без fetch",
    find: String.raw`      const url = COMPONENT_DIR + "/" + encodeURIComponent(name) + ".dc.html";
      const res = window.__resources;
      const pre = res ? res[url] : void 0;
      const target = typeof pre === "string" && pre ? pre : url;
      const blob = bundledBlob(target);
      (blob ? blob.text() : fetch(target).then((res2) => {
        if (!res2.ok) {
          console.error(
            '[dc-runtime] sibling fetch for "' + name + '" failed:',
            url,
            "returned",
            res2.status,
            "${EM_DASH} the reference renders as an empty placeholder."
          );
          return "";
        }
        return res2.text();
      })).then((t) => {
        if (!t) return;
        const parsed = parseDcText(t);
        if (!parsed) {
          console.error(
            '[dc-runtime] sibling fetch for "' + name + '":',
            url,
            "has no <x-dc> block ${EM_DASH} not a Design Component."
          );
          return;
        }
        if (parsed.props) r.propsMeta = parsed.props;
        if (parsed.preview) r.preview = parsed.preview;
        if (parsed.template && !r.html) updateHtml(name, parsed.template);
        if (parsed.js && !r.Logic) updateJs(name, parsed.js);
      }).catch(
        (e) => console.error(
          '[dc-runtime] sibling fetch for "' + name + '" threw:',
          url,
          e
        )
      );
`,
    replace: String.raw`      // [invito] Вложенные DC (InviteCover) тоже из /app/dc-bundle.js, без fetch. Разбор синхронный:
      // первый вызов приходит из рендера первого экземпляра, подписчиков у записи ещё нет, и он
      // сразу получает шаблон и логику вместо заглушки.
      const parsed = dcSource(name);
      if (!parsed) {
        console.error('[dc-runtime] "' + name + '" is not in dc-bundle.js, the reference renders as an empty placeholder.');
        return;
      }
      if (parsed.props) r.propsMeta = parsed.props;
      if (parsed.preview) r.preview = parsed.preview;
      if (parsed.template && !r.html) updateHtml(name, parsed.template);
      if (parsed.js && !r.Logic) updateJs(name, parsed.js);
`,
  },
  {
    why: "React без unpkg",
    find: String.raw`    const react = cdnScriptFor(REACT_URL, REACT_SRI);
    const reactDom = cdnScriptFor(REACT_DOM_URL, REACT_DOM_SRI);
    return Promise.all([
      loadScript(react.src, react.integrity),
      loadScript(reactDom.src, reactDom.integrity)
    ]).then(() => void 0);
`,
    replace: String.raw`    // [invito] React и ReactDOM подключает оболочка из /app/vendor/ до support.js, с unpkg ничего не грузится.
    return Promise.reject(new Error("window.React / window.ReactDOM are missing: /app/vendor scripts must load before support.js"));
`,
  },
  {
    why: "без postMessage редактору (режим документа)",
    find: String.raw`    function postDesignMode(mode) {
      if (window.parent === window) return;
      try {
        window.parent.postMessage({ type: "__dc_design_mode", mode }, "*");
      } catch {
      }
    }
`,
    replace: String.raw`    // [invito] Сообщения редактору Claude Design не отправляются: в Telegram Web родитель — чужое окно.
    function postDesignMode(mode) {
    }
`,
  },
  {
    why: "без обработчика message без проверки источника",
    find: String.raw`    window.addEventListener("message", (e) => {
      const type = e.data && e.data.type;
      if (type === "__dc_theme") {
        const t = e.data.theme;
        if (t === "light" || t === "dark") {
          appTheme = t;
          applyCanvasBg();
        }
        return;
      }
      if (!designDocMode || type !== "__dc_probe") return;
      postDesignMode(designDocMode);
    });
`,
    replace: String.raw`    // [invito] Команды редактора через message (без проверки источника) не принимаются.
`,
  },
  {
    why: "без postMessage редактору (загрузка)",
    find: String.raw`    const notifyHost = () => {
      if (window.parent === window) return;
      const r = runtime.registry.entries[rootName];
      try {
        window.parent.postMessage(
          {
            type: "__dc_booted",
            rootName,
            propsMeta: r && r.propsMeta || null,
            preview: r && r.preview || null
          },
          "*"
        );
      } catch {
      }
    };
`,
    replace: String.raw`    // [invito] Редактору Claude Design о загрузке не сообщаем (postMessage в чужое родительское окно).
    const notifyHost = () => {
    };
`,
  },
];
