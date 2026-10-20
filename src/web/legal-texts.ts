import { toCyr } from "../design-data.js";
import type { Locale } from "../i18n.js";

/**
 * Тексты страниц /oferta, /privacy и /contacts на ru, uz и en; uzc получается из uz через toCyr.
 *
 * Подстановки: {executor} — название компании из реквизитов или «администрация сайта <host>»,
 * {site} — ссылка на сайт, {host} — домен из APP_URL, {app} — APP_NAME. «[текст](privacy)» —
 * ссылка на другую страницу документов на том же языке. Реквизиты подставляет блок { slot }.
 */

/** Дата текущей редакции документов: меняется вместе с текстами оферты и политики. */
export const LEGAL_REVISION = "2026-10-20";

export const LEGAL_PAGES = ["oferta", "privacy", "contacts"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

/**
 * Блок раздела: абзац (в нумерованном документе получает номер «2.3»), список или данные из настроек:
 * details — реквизиты, контакты и сайт; contacts — только контакты и сайт; company — только реквизиты.
 */
export type Block = string | { list: string[] } | { slot: "details" | "contacts" | "company" };
export type Section = { id: string; title: string; blocks: Block[] };
export type LegalDoc = { title: string; description: string; lead: string; numbered: boolean; sections: Section[] };

export type LegalField =
  | "companyName"
  | "inn"
  | "address"
  | "phone"
  | "email"
  | "telegram"
  | "bankName"
  | "bankAccount"
  | "mfo"
  | "director"
  | "site"
  | "bot";

export type LegalTexts = {
  docs: Record<LegalPage, LegalDoc>;
  ui: {
    /** Строка под заголовком: «Редакция от {date}». */
    revision: string;
    toc: string;
    home: string;
    langLabel: string;
    docsLabel: string;
    nav: Record<LegalPage, string>;
    /** {executor}, если название компании не заполнено. */
    executor: string;
    fields: Record<LegalField, string>;
    /** Пометка о переводе (только en). */
    note?: string;
  };
};

const ru: LegalTexts = {
  ui: {
    revision: "Редакция от {date}",
    toc: "Содержание",
    home: "Вернуться на сайт",
    langLabel: "Язык",
    docsLabel: "Документы",
    nav: { oferta: "Оферта", privacy: "Конфиденциальность", contacts: "Контакты" },
    executor: "администрация сайта {host}",
    fields: {
      companyName: "Наименование",
      inn: "ИНН (СТИР)",
      address: "Адрес",
      phone: "Телефон",
      email: "Электронная почта",
      telegram: "Telegram",
      bankName: "Банк",
      bankAccount: "Расчётный счёт",
      mfo: "МФО банка",
      director: "Руководитель",
      site: "Сайт",
      bot: "Telegram-бот",
    },
  },
  docs: {
    oferta: {
      title: "Публичная оферта",
      description: "Условия услуг {app}: создание и публикация онлайн-приглашений, цены, оплата банковской картой через Multicard, возврат денег и реквизиты.",
      lead: "Договор об оказании услуг по созданию и публикации онлайн-приглашений на сайте {site}.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "Общие положения",
          blocks: [
            "Этот документ — публичная оферта: {executor} (далее — «Исполнитель») предлагает любому дееспособному лицу (далее — «Заказчик») заключить договор об оказании услуг на условиях ниже.",
            "Оферта адресована неограниченному кругу лиц и опубликована на сайте {site}. Договор считается заключённым с момента акцепта оферты.",
            "Термины в оферте:",
            {
              list: [
                "«Сайт» — сайт {site}, а также мини-приложение и бот {app} в Telegram;",
                "«Сервис» — программные средства Сайта для создания, публикации и рассылки приглашений;",
                "«Приглашение» — онлайн-страница о событии, которую Заказчик создаёт на Сайте по одному из шаблонов;",
                "«Гость» — человек, которому Заказчик отправляет Приглашение;",
                "«Место» — персональная ссылка на Приглашение для одного Гостя;",
                "«Подписка» — доступ ко всем шаблонам Сайта на оплаченный срок;",
                "«Заказ» — Услуга, которую Заказчик выбрал и оплатил на Сайте.",
              ],
            },
          ],
        },
        {
          id: "subject",
          title: "Предмет договора",
          blocks: [
            "Исполнитель предоставляет Заказчику доступ к Сервису и оказывает услуги по созданию и публикации онлайн-приглашений (далее — «Услуги»), а Заказчик оплачивает их на условиях оферты.",
            "На Сайте можно оплатить:",
            {
              list: [
                "публикацию Приглашения по одной общей ссылке для всех Гостей — оплата за шаблон;",
                "персональные Приглашения: у каждого Гостя своя ссылка, а его ответ сразу попадает в список Заказчика — оплата за каждое Место; если для шаблона доступна рассылка по SMS, Гостям можно отправить приглашение и по SMS;",
                "Подписку на срок, выбранный при оплате: любые шаблоны без отдельной оплаты, Места оплачиваются отдельно.",
              ],
            },
            "Создание черновиков, выбор шаблонов и предварительный просмотр бесплатны.",
            "Услуги оказываются через интернет; материальные носители не передаются.",
          ],
        },
        {
          id: "acceptance",
          title: "Акцепт оферты и оформление Заказа",
          blocks: [
            "Акцепт оферты — оплата Заказа на Сайте. Оплачивая Заказ, Заказчик подтверждает, что прочитал оферту и [Политику конфиденциальности](privacy) и принимает их полностью и без оговорок.",
            "Чтобы оформить Заказ, Заказчик входит на Сайт по номеру телефона или через Telegram, выбирает шаблон, способ публикации и, для персональных Приглашений, количество Мест.",
            "Если Исполнитель предоставил Заказчику бесплатный доступ, Заказы выполняются без оплаты, а остальные условия оферты действуют.",
          ],
        },
        {
          id: "payment",
          title: "Цены и оплата",
          blocks: [
            "Цены Услуг указаны на Сайте в узбекских сумах. Действует цена, которая показана на Сайте в момент оплаты Заказа.",
            "Исполнитель вправе менять цены. Новые цены не применяются к уже оплаченным Заказам.",
            "Оплата принимается банковскими картами через платёжную систему Multicard; доступные виды карт показаны на странице оплаты. Данные карты Заказчик вводит на странице платёжной системы; полный номер карты, срок её действия и код безопасности Исполнитель не получает и не хранит.",
            "Заказ считается оплаченным, когда платёжная система подтвердит оплату. Фискальный чек формирует платёжная система в порядке, установленном законодательством Республики Узбекистан.",
            "Подписка не продлевается автоматически: без действия Заказчика повторных списаний нет.",
          ],
        },
        {
          id: "delivery",
          title: "Оказание Услуг",
          blocks: [
            "Услуга оказана, когда после подтверждения оплаты Сайт открыл доступ к оплаченному: Приглашение можно опубликовать или оно уже опубликовано, Места добавлены к Приглашению, Подписка действует. Обычно это происходит сразу после оплаты.",
            "Подписка действует оплаченное число месяцев с момента оплаты. Если в момент оплаты уже действует Подписка, новый срок прибавляется к ней.",
            "Опубликованное Приглашение открывается по ссылке, пока Заказчик его не удалит: удалённое Приглашение переносится в архив и больше не открывается Гостям, а список Гостей и их ответы удаляются.",
            "Заказчик может менять содержание опубликованного Приглашения; Гости видят изменения сразу.",
            "Доставка SMS и сообщений в Telegram зависит от операторов связи и Telegram. Исполнитель не гарантирует, что Гость прочитает приглашение или ответит на него.",
          ],
        },
        {
          id: "refunds",
          title: "Возврат денег",
          blocks: [
            "Пока Приглашение, за которое внесена оплата, не опубликовано, Заказчик вправе отказаться от Услуги и получить деньги обратно полностью. Для Подписки это действует, пока по ней не опубликовано ни одного Приглашения.",
            "После публикации Услуга считается оказанной. Деньги возвращаются в случаях, предусмотренных законодательством Республики Узбекистан, в том числе если Услуга оказана ненадлежащим образом по вине Исполнителя.",
            "Если оплата прошла, а доступ не открылся, Исполнитель выполнит Заказ или вернёт оплату полностью.",
            "Запрос на возврат направляется по [контактам Исполнителя](contacts) с номером Заказа и номером телефона аккаунта. Исполнитель рассматривает запрос в течение 10 рабочих дней.",
            "Деньги возвращаются на карту, с которой была оплата, через платёжную систему; срок зачисления зависит от банка, выпустившего карту. После возврата Исполнитель вправе закрыть доступ к оплаченному (шаблону, Местам или Подписке).",
          ],
        },
        {
          id: "duties",
          title: "Права и обязанности сторон",
          blocks: [
            "Исполнитель обязуется:",
            {
              list: [
                "открыть Заказчику оплаченные возможности Сервиса;",
                "поддерживать работу Сайта и устранять сбои в разумный срок;",
                "отвечать на обращения Заказчика;",
                "обрабатывать персональные данные согласно [Политике конфиденциальности](privacy).",
              ],
            },
            "Заказчик обязуется:",
            {
              list: [
                "указывать достоверные данные и не передавать доступ к аккаунту другим людям;",
                "не размещать в Приглашениях материалы, которые нарушают законодательство Республики Узбекистан или права других людей, в том числе авторские права на тексты, фотографии, видео и музыку;",
                "добавлять в Сервис имена и номера телефонов Гостей только с их согласия и приглашать их на события, а не рассылать рекламу;",
                "не нарушать работу Сайта и не обходить ограничения Сервиса.",
              ],
            },
            "Исполнитель вправе снять Приглашение с публикации или приостановить доступ к аккаунту, если Заказчик нарушает оферту или законодательство.",
          ],
        },
        {
          id: "liability",
          title: "Ответственность",
          blocks: [
            "Заказчик отвечает за содержание своих Приглашений, в том числе за загруженные материалы, и за то, что вправе передавать в Сервис данные Гостей.",
            "Исполнитель не отвечает за содержание Приглашений, созданных Заказчиком, и за сбои сторонних сервисов: операторов связи, Telegram, платёжной системы, интернет-провайдеров.",
            "Ответственность Исполнителя перед Заказчиком ограничена суммой, уплаченной за соответствующий Заказ, если законодательство не устанавливает иное.",
            "Стороны освобождаются от ответственности за неисполнение обязательств из-за обстоятельств непреодолимой силы.",
          ],
        },
        {
          id: "availability",
          title: "Работа Сервиса",
          blocks: [
            "Сервис работает круглосуточно, кроме времени технических работ и сбоев. Исполнитель старается проводить работы так, чтобы опубликованные Приглашения оставались доступны.",
            "Исполнитель может менять оформление и возможности Сервиса, не ухудшая уже оплаченные Услуги.",
            "Заказчику стоит хранить собственные копии загруженных фотографий, видео и музыки.",
          ],
        },
        {
          id: "data",
          title: "Персональные данные",
          blocks: [
            "Исполнитель обрабатывает персональные данные Заказчика и Гостей по Закону Республики Узбекистан «О персональных данных» и [Политике конфиденциальности](privacy).",
            "Добавляя данные Гостей, Заказчик подтверждает, что Гости согласны получить приглашение, в том числе по SMS или в Telegram, и что их данные будут обработаны для этого.",
          ],
        },
        {
          id: "changes",
          title: "Срок действия и изменение оферты",
          blocks: [
            "Договор действует с момента акцепта до полного исполнения обязательств.",
            "Исполнитель может изменять оферту, публикуя новую редакцию на этой странице. Новая редакция действует с момента публикации; к Заказам, оплаченным раньше, применяется редакция, которая действовала в момент оплаты.",
          ],
        },
        {
          id: "law",
          title: "Применимое право и споры",
          blocks: [
            "К договору применяется законодательство Республики Узбекистан.",
            "Споры стороны решают переговорами. Претензию можно направить по [контактам Исполнителя](contacts); Исполнитель отвечает на неё в течение 10 рабочих дней. Если договориться не удалось, спор решается в суде в порядке, установленном законодательством Республики Узбекистан.",
          ],
        },
        { id: "details", title: "Реквизиты Исполнителя", blocks: [{ slot: "details" }] },
      ],
    },
    privacy: {
      title: "Политика конфиденциальности",
      description: "Какие персональные данные собирает {app}, зачем, как хранит и защищает, кому передаёт и как их удалить.",
      lead: "Как мы обрабатываем персональные данные пользователей и гостей сайта {site}.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "Общие положения",
          blocks: [
            "Политика описывает, как {executor} (далее — «мы») обрабатывает персональные данные на сайте {site}, в мини-приложении и боте {app} в Telegram (далее — «Сервис»).",
            "Мы обрабатываем персональные данные по Закону Республики Узбекистан от 2 июля 2019 года № ЗРУ-547 «О персональных данных».",
            "Пользуясь Сервисом, вы соглашаетесь с Политикой. Если вы с ней не согласны, не пользуйтесь Сервисом.",
          ],
        },
        {
          id: "collect",
          title: "Какие данные мы собираем",
          blocks: [
            "Данные пользователей, которые создают приглашения:",
            {
              list: [
                "номер телефона — для входа по коду из SMS и как идентификатор аккаунта;",
                "данные Telegram при входе через Telegram: ID, имя, фамилия, имя пользователя (username) и язык;",
                "имя в профиле, язык интерфейса, сведения о заказах и подписке: номер заказа, сумма, статус, время оплаты.",
              ],
            },
            "Содержание приглашений: имена, дата, время и место события, тексты, программа, контакты организатора, загруженные фотографии, видео и музыка.",
            "Данные гостей, которые добавляет организатор или сам гость: имя, номер телефона, группа и стол в рассадке, ответ на приглашение (придёт ли, сколько человек, пожелания по питанию, сообщение организатору), время открытия приглашения и отметка о приходе. Если гость пишет боту, мы сохраняем ID его чата в Telegram, чтобы присылать напоминания.",
            "Технические данные: IP-адрес, сведения о браузере (User-Agent), время запросов. Они нужны для работы и защиты Сервиса.",
            "Полный номер банковской карты, срок её действия и код безопасности мы не получаем и не храним: их вводят на странице платёжной системы.",
          ],
        },
        {
          id: "purposes",
          title: "Зачем мы обрабатываем данные",
          blocks: [
            "Мы используем данные, чтобы:",
            {
              list: [
                "создать аккаунт, обеспечить вход в него и хранить ваши приглашения;",
                "публиковать приглашения и доставлять их гостям по ссылке, по SMS или в Telegram;",
                "собирать ответы гостей, показывать их организатору и присылать ему уведомления;",
                "принимать оплату и выполнять заказы;",
                "отвечать на обращения;",
                "защищать Сервис от злоупотреблений и сбоев;",
                "выполнять требования законодательства.",
              ],
            },
            "Мы не продаём персональные данные и не используем их для рекламных рассылок.",
          ],
        },
        {
          id: "basis",
          title: "Правовые основания",
          blocks: [
            "Данные пользователей мы обрабатываем с их согласия, которое они дают, когда входят в Сервис, и для исполнения договора по [публичной оферте](oferta).",
            "Данные гостей добавляет организатор и подтверждает, что гости согласны получить приглашение. Мы обрабатываем эти данные только для доставки приглашения и сбора ответов. Гость, который сам отвечает на приглашение, соглашается на обработку данных, которые он указал.",
            "Сведения о платежах мы храним, потому что этого требует законодательство.",
          ],
        },
        {
          id: "storage",
          title: "Хранение и защита",
          blocks: [
            "Данные хранятся на защищённых серверах Сервиса, сайт работает только по защищённому протоколу HTTPS. Доступ к серверам и базам данных есть только у администраторов Сервиса.",
            "Персональные ссылки гостей содержат случайный ключ, страницы приглашений закрыты от поисковых систем, а организатор может защитить приглашение паролем.",
            "Загруженные фотографии, видео и музыка открываются по прямой ссылке без входа: так их видят гости на странице приглашения.",
          ],
        },
        {
          id: "sharing",
          title: "Кому мы передаём данные",
          blocks: [
            "Мы передаём данные только тем, кто помогает оказывать услугу, и только в нужном объёме:",
            {
              list: [
                "Eskiz (SMS-провайдер) — номер телефона и текст SMS: коды входа, приглашения и напоминания гостям;",
                "Multicard (платёжная система) — номер заказа, сумма и описание покупки; данные карты вы вводите на странице Multicard;",
                "Telegram — сообщения бота, если вы или ваш гость пользуетесь ботом или мини-приложением;",
                "Anthropic (США) — только когда организатор просит помощника написать текст приглашения: тип события, имена, дата и место;",
                "Google, Unsplash и Telegram — страницы сайта загружают шрифты Google Fonts, примеры фотографий из Unsplash и скрипт мини-приложения Telegram, а страница приглашения — карту Google Maps с адресом места, поэтому эти сервисы получают IP-адрес браузера.",
              ],
            },
            "Зарубежным сервисам из этого списка (Telegram, Anthropic, Google, Unsplash) данные передаются только в описанном объёме.",
            "Гости видят то, что организатор разместил в приглашении. Если организатор включил список «Кто придёт», гости видят имя и первую букву фамилии тех, кто ответил «да»; пожелания в гостевой книге видят все, кто открыл приглашение.",
            "Государственным органам мы раскрываем данные только по основаниям, предусмотренным законодательством Республики Узбекистан.",
          ],
        },
        {
          id: "retention",
          title: "Сроки хранения",
          blocks: [
            "Мы храним данные не дольше, чем нужно:",
            {
              list: [
                "данные аккаунта и приглашений — пока существует аккаунт; удалённый черновик, для которого ничего не оплачено и не получено по подписке или бесплатному доступу и оплата не начата, удаляется сразу вместе с загруженными в него файлами (кроме тех, что есть в других ваших приглашениях), а остальные удалённые приглашения переносятся в архив и больше не открываются гостям;",
                "данные гостей — пока организатор не удалит гостя или приглашение; при удалении приглашения, в том числе при переносе в архив, его гости удаляются сразу;",
                "журнал SMS — номер телефона, время и статус каждой отправки, чтобы сверять отправки с SMS-провайдером и защищать Сервис от злоупотреблений; текст SMS с кодом входа мы не сохраняем, а у SMS гостям номер и текст (с именем гостя и его личной ссылкой) стираются, как только организатор удаляет гостя или приглашение, в том числе при переносе в архив;",
                "сведения о заказах и платежах — не меньше сроков, установленных законодательством о бухгалтерском учёте и налогах;",
                "технические журналы — ограниченное время, которое нужно для защиты Сервиса.",
              ],
            },
            "Когда срок истёк или вы попросили удалить данные, мы удаляем или обезличиваем их.",
          ],
        },
        {
          id: "rights",
          title: "Ваши права",
          blocks: [
            "Вы вправе:",
            {
              list: [
                "узнать, какие ваши данные мы обрабатываем и зачем, и получить их копию;",
                "потребовать исправить неточные данные;",
                "отозвать согласие и потребовать удалить данные; сведения о платежах мы храним, пока этого требует закон;",
                "обжаловать наши действия в уполномоченном государственном органе по персональным данным или в суде.",
              ],
            },
            "Чтобы воспользоваться правами, напишите нам по [контактам](contacts) с номера телефона или из Telegram, привязанных к аккаунту. Мы можем попросить подтвердить, что запрос отправили вы, и ответим в сроки, установленные законодательством.",
            "Гость может попросить организатора приглашения или нас удалить свои данные: мы удалим их из приглашения.",
          ],
        },
        {
          id: "cookies",
          title: "Cookie и хранилище браузера",
          blocks: [
            "Мы используем только необходимые cookie: cookie сессии хранит вход на сайт до 30 дней или до выхода, ещё одна действует, пока идёт вход через Telegram.",
            "В хранилище браузера (localStorage) сохраняются язык и тема интерфейса, незавершённые вход через Telegram и оплата, последний открытый шаг конструктора, а у гостя — его ответ на приглашение, чтобы его можно было изменить.",
            "Рекламных и аналитических cookie сторонних сервисов на сайте нет.",
          ],
        },
        {
          id: "changes",
          title: "Изменения Политики",
          blocks: ["Мы можем обновлять Политику. Новая редакция публикуется на этой странице с датой и действует с момента публикации."],
        },
        {
          id: "operator",
          title: "Оператор и контакты",
          blocks: ["Вопросы о персональных данных и запросы на удаление присылайте по [контактам](contacts).", { slot: "details" }],
        },
      ],
    },
    contacts: {
      title: "Контакты",
      description: "Как связаться с {app}: Telegram, телефон, электронная почта и реквизиты.",
      lead: "Пишите по любым вопросам: как создать приглашение, оплата и возврат денег, удаление данных.",
      numbered: false,
      sections: [
        {
          id: "write",
          title: "Связаться с нами",
          blocks: [{ slot: "contacts" }, "По вопросам оплаты и возврата укажите номер заказа и номер телефона аккаунта."],
        },
        { id: "details", title: "Реквизиты", blocks: [{ slot: "company" }] },
        {
          id: "docs",
          title: "Документы",
          blocks: [
            {
              list: [
                "[Публичная оферта](oferta) — условия оказания услуг и возврата денег.",
                "[Политика конфиденциальности](privacy) — как мы обрабатываем персональные данные.",
              ],
            },
          ],
        },
      ],
    },
  },
};

const uz: LegalTexts = {
  ui: {
    revision: "Tahrir: {date}",
    toc: "Mundarija",
    home: "Saytga qaytish",
    langLabel: "Til",
    docsLabel: "Hujjatlar",
    nav: { oferta: "Oferta", privacy: "Maxfiylik", contacts: "Kontaktlar" },
    executor: "{host} sayti ma’muriyati",
    fields: {
      companyName: "Nomi",
      inn: "STIR",
      address: "Manzil",
      phone: "Telefon",
      email: "Elektron pochta",
      telegram: "Telegram",
      bankName: "Bank",
      bankAccount: "Hisob raqami",
      mfo: "Bank MFO kodi",
      director: "Rahbar",
      site: "Sayt",
      bot: "Telegram bot",
    },
  },
  docs: {
    oferta: {
      title: "Ommaviy oferta",
      description: "{app} xizmatlari shartlari: onlayn taklifnomalarni yaratish va e’lon qilish, narxlar, Multicard orqali bank kartasi bilan to‘lov, pulni qaytarish va rekvizitlar.",
      lead: "{site} saytida onlayn taklifnomalarni yaratish va e’lon qilish xizmatlarini ko‘rsatish shartnomasi.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "Umumiy qoidalar",
          blocks: [
            "Ushbu hujjat ommaviy oferta hisoblanadi: {executor} (keyingi o‘rinlarda — «Ijrochi») har qanday muomalaga layoqatli shaxsga (keyingi o‘rinlarda — «Buyurtmachi») quyidagi shartlar asosida xizmat ko‘rsatish shartnomasini tuzishni taklif qiladi.",
            "Oferta cheklanmagan doiradagi shaxslarga qaratilgan va {site} saytida e’lon qilingan. Shartnoma oferta aksept qilingan paytdan boshlab tuzilgan hisoblanadi.",
            "Ofertadagi atamalar:",
            {
              list: [
                "«Sayt» — {site} sayti, shuningdek Telegramdagi {app} mini-ilovasi va boti;",
                "«Servis» — taklifnomalarni yaratish, e’lon qilish va yuborish uchun Saytning dasturiy vositalari;",
                "«Taklifnoma» — Buyurtmachi Saytda shablonlardan biri asosida yaratadigan tadbir haqidagi onlayn sahifa;",
                "«Mehmon» — Buyurtmachi Taklifnoma yuboradigan shaxs;",
                "«Joy» — bitta Mehmon uchun Taklifnomaning shaxsiy havolasi;",
                "«Obuna» — to‘langan muddat davomida Saytdagi barcha shablonlardan foydalanish huquqi;",
                "«Buyurtma» — Buyurtmachi Saytda tanlagan va to‘lagan Xizmat.",
              ],
            },
          ],
        },
        {
          id: "subject",
          title: "Shartnoma predmeti",
          blocks: [
            "Ijrochi Buyurtmachiga Servisdan foydalanish imkonini beradi va onlayn taklifnomalarni yaratish va e’lon qilish xizmatlarini (keyingi o‘rinlarda — «Xizmatlar») ko‘rsatadi, Buyurtmachi esa ularni oferta shartlari asosida to‘laydi.",
            "Saytda quyidagilar uchun to‘lash mumkin:",
            {
              list: [
                "Taklifnomani barcha Mehmonlar uchun bitta umumiy havola orqali e’lon qilish — shablon uchun to‘lov;",
                "shaxsiy Taklifnomalar: har bir Mehmonning o‘z havolasi bor, uning javobi esa darhol Buyurtmachi ro‘yxatiga tushadi — har bir Joy uchun to‘lov; agar shablonda SMS yuborish mavjud bo‘lsa, Mehmonlarga taklifnomani SMS orqali ham yuborish mumkin;",
                "to‘lov paytida tanlangan muddatga Obuna: har qanday shablon alohida to‘lovsiz, Joylar alohida to‘lanadi.",
              ],
            },
            "Qoralamalar yaratish, shablon tanlash va oldindan ko‘rish bepul.",
            "Xizmatlar internet orqali ko‘rsatiladi; moddiy tashuvchilar berilmaydi.",
          ],
        },
        {
          id: "acceptance",
          title: "Ofertani aksept qilish va Buyurtma berish",
          blocks: [
            "Ofertani aksept qilish — Saytda Buyurtma uchun to‘lov qilish. Buyurtmani to‘lash orqali Buyurtmachi oferta va [Maxfiylik siyosati](privacy) bilan tanishganini hamda ularni to‘liq va so‘zsiz qabul qilishini tasdiqlaydi.",
            "Buyurtma berish uchun Buyurtmachi Saytga telefon raqami yoki Telegram orqali kiradi, shablonni, e’lon qilish usulini va shaxsiy Taklifnomalar uchun Joylar sonini tanlaydi.",
            "Agar Ijrochi Buyurtmachiga bepul foydalanish huquqini bergan bo‘lsa, Buyurtmalar to‘lovsiz bajariladi, ofertaning qolgan shartlari esa amal qiladi.",
          ],
        },
        {
          id: "payment",
          title: "Narxlar va to‘lov",
          blocks: [
            "Xizmatlar narxi Saytda o‘zbek so‘mida ko‘rsatilgan. Buyurtma to‘langan paytda Saytda ko‘rsatilgan narx amal qiladi.",
            "Ijrochi narxlarni o‘zgartirishga haqli. Yangi narxlar allaqachon to‘langan Buyurtmalarga qo‘llanilmaydi.",
            "To‘lov Multicard to‘lov tizimi orqali bank kartalari bilan qabul qilinadi; qaysi kartalar qabul qilinishi to‘lov sahifasida ko‘rsatiladi. Karta ma’lumotlarini Buyurtmachi to‘lov tizimi sahifasida kiritadi; kartaning to‘liq raqami, amal qilish muddati va xavfsizlik kodini Ijrochi olmaydi va saqlamaydi.",
            "To‘lov tizimi to‘lovni tasdiqlaganda Buyurtma to‘langan hisoblanadi. Fiskal chekni to‘lov tizimi O‘zbekiston Respublikasi qonunchiligida belgilangan tartibda shakllantiradi.",
            "Obuna avtomatik ravishda uzaytirilmaydi: Buyurtmachining harakatisiz kartadan qayta pul yechib olinmaydi.",
          ],
        },
        {
          id: "delivery",
          title: "Xizmatlarni ko‘rsatish",
          blocks: [
            "To‘lov tasdiqlangandan so‘ng Sayt to‘langan imkoniyatni ochganda Xizmat ko‘rsatilgan hisoblanadi: Taklifnomani e’lon qilish mumkin yoki u allaqachon e’lon qilingan, Joylar Taklifnomaga qo‘shilgan, Obuna amal qilmoqda. Odatda bu to‘lovdan so‘ng darhol sodir bo‘ladi.",
            "Obuna to‘lov paytidan boshlab to‘langan oylar soni davomida amal qiladi. Agar to‘lov paytida Obuna allaqachon amal qilayotgan bo‘lsa, yangi muddat unga qo‘shiladi.",
            "E’lon qilingan Taklifnoma Buyurtmachi uni o‘chirmaguncha havola orqali ochiladi: o‘chirilgan Taklifnoma arxivga o‘tkaziladi va Mehmonlarga boshqa ochilmaydi, Mehmonlar ro‘yxati va ularning javoblari esa o‘chiriladi.",
            "Buyurtmachi e’lon qilingan Taklifnoma mazmunini o‘zgartirishi mumkin; Mehmonlar o‘zgarishlarni darhol ko‘radi.",
            "SMS va Telegramdagi xabarlarning yetkazilishi aloqa operatorlari va Telegramga bog‘liq. Ijrochi Mehmon taklifnomani o‘qishi yoki unga javob berishiga kafolat bermaydi.",
          ],
        },
        {
          id: "refunds",
          title: "Pulni qaytarish",
          blocks: [
            "To‘lov qilingan Taklifnoma e’lon qilinmaguncha Buyurtmachi Xizmatdan voz kechib, pulni to‘liq qaytarib olishga haqli. Obuna uchun bu u bo‘yicha birorta ham Taklifnoma e’lon qilinmaguncha amal qiladi.",
            "E’lon qilingandan so‘ng Xizmat ko‘rsatilgan hisoblanadi. Pul O‘zbekiston Respublikasi qonunchiligida nazarda tutilgan hollarda, jumladan Xizmat Ijrochining aybi bilan lozim darajada ko‘rsatilmagan bo‘lsa, qaytariladi.",
            "Agar to‘lov o‘tgan, lekin imkoniyat ochilmagan bo‘lsa, Ijrochi Buyurtmani bajaradi yoki to‘lovni to‘liq qaytaradi.",
            "Pulni qaytarish so‘rovi Buyurtma raqami va akkaunt telefon raqami ko‘rsatilgan holda [Ijrochi kontaktlari](contacts) orqali yuboriladi. Ijrochi so‘rovni 10 ish kuni ichida ko‘rib chiqadi.",
            "Pul to‘lov tizimi orqali to‘lov qilingan kartaga qaytariladi; tushish muddati kartani chiqargan bankka bog‘liq. Pul qaytarilgandan so‘ng Ijrochi to‘langan imkoniyatdan (shablon, Joylar yoki Obuna) foydalanishni to‘xtatishga haqli.",
          ],
        },
        {
          id: "duties",
          title: "Tomonlarning huquq va majburiyatlari",
          blocks: [
            "Ijrochi quyidagilarni o‘z zimmasiga oladi:",
            {
              list: [
                "Buyurtmachiga Servisning to‘langan imkoniyatlarini ochish;",
                "Sayt ishini ta’minlash va nosozliklarni oqilona muddatda bartaraf etish;",
                "Buyurtmachining murojaatlariga javob berish;",
                "shaxsga doir ma’lumotlarni [Maxfiylik siyosati](privacy)ga muvofiq qayta ishlash.",
              ],
            },
            "Buyurtmachi quyidagilarni o‘z zimmasiga oladi:",
            {
              list: [
                "ishonchli ma’lumotlarni ko‘rsatish va akkauntdan foydalanishni boshqa shaxslarga bermaslik;",
                "Taklifnomalarda O‘zbekiston Respublikasi qonunchiligini yoki boshqa shaxslarning huquqlarini, jumladan matnlar, fotosuratlar, video va musiqaga bo‘lgan mualliflik huquqlarini buzadigan materiallarni joylashtirmaslik;",
                "Servisga Mehmonlarning ismlari va telefon raqamlarini faqat ularning roziligi bilan qo‘shish va ularni reklama yuborish uchun emas, balki tadbirlarga taklif qilish uchun ishlatish;",
                "Sayt ishini buzmaslik va Servis cheklovlarini chetlab o‘tmaslik.",
              ],
            },
            "Agar Buyurtmachi oferta yoki qonunchilikni buzsa, Ijrochi Taklifnomani e’londan olib tashlashga yoki akkauntdan foydalanishni to‘xtatib turishga haqli.",
          ],
        },
        {
          id: "liability",
          title: "Javobgarlik",
          blocks: [
            "Buyurtmachi o‘z Taklifnomalarining mazmuni, jumladan yuklangan materiallar uchun, shuningdek Mehmonlar ma’lumotlarini Servisga berishga haqli ekanligi uchun javob beradi.",
            "Ijrochi Buyurtmachi yaratgan Taklifnomalar mazmuni va uchinchi tomon servislaridagi (aloqa operatorlari, Telegram, to‘lov tizimi, internet-provayderlar) nosozliklar uchun javob bermaydi.",
            "Agar qonunchilikda boshqacha belgilanmagan bo‘lsa, Ijrochining Buyurtmachi oldidagi javobgarligi tegishli Buyurtma uchun to‘langan summa bilan cheklanadi.",
            "Tomonlar majburiyatlarni yengib bo‘lmaydigan kuch holatlari tufayli bajarmaganlik uchun javobgarlikdan ozod qilinadi.",
          ],
        },
        {
          id: "availability",
          title: "Servisning ishlashi",
          blocks: [
            "Servis texnik ishlar va nosozliklar vaqtidan tashqari kecha-kunduz ishlaydi. Ijrochi ishlarni e’lon qilingan Taklifnomalar ochiq qoladigan tarzda o‘tkazishga harakat qiladi.",
            "Ijrochi allaqachon to‘langan Xizmatlarni yomonlashtirmagan holda Servisning ko‘rinishi va imkoniyatlarini o‘zgartirishi mumkin.",
            "Buyurtmachiga yuklangan fotosuratlar, video va musiqaning o‘z nusxalarini saqlab qo‘yish tavsiya etiladi.",
          ],
        },
        {
          id: "data",
          title: "Shaxsga doir ma’lumotlar",
          blocks: [
            "Ijrochi Buyurtmachi va Mehmonlarning shaxsga doir ma’lumotlarini O‘zbekiston Respublikasining «Shaxsga doir ma’lumotlar to‘g‘risida»gi Qonuni va [Maxfiylik siyosati](privacy)ga muvofiq qayta ishlaydi.",
            "Mehmonlar ma’lumotlarini qo‘shish orqali Buyurtmachi Mehmonlar taklifnomani, jumladan SMS yoki Telegram orqali olishga va buning uchun ularning ma’lumotlari qayta ishlanishiga rozi ekanligini tasdiqlaydi.",
          ],
        },
        {
          id: "changes",
          title: "Amal qilish muddati va ofertani o‘zgartirish",
          blocks: [
            "Shartnoma aksept qilingan paytdan boshlab majburiyatlar to‘liq bajarilgunga qadar amal qiladi.",
            "Ijrochi ushbu sahifada yangi tahririni e’lon qilish orqali ofertani o‘zgartirishi mumkin. Yangi tahrir e’lon qilingan paytdan boshlab amal qiladi; avval to‘langan Buyurtmalarga to‘lov paytida amalda bo‘lgan tahrir qo‘llaniladi.",
          ],
        },
        {
          id: "law",
          title: "Qo‘llaniladigan huquq va nizolar",
          blocks: [
            "Shartnomaga O‘zbekiston Respublikasi qonunchiligi qo‘llaniladi.",
            "Tomonlar nizolarni muzokaralar yo‘li bilan hal qiladi. Da’voni [Ijrochi kontaktlari](contacts) orqali yuborish mumkin; Ijrochi unga 10 ish kuni ichida javob beradi. Kelishuvga erishilmasa, nizo O‘zbekiston Respublikasi qonunchiligida belgilangan tartibda sudda hal qilinadi.",
          ],
        },
        { id: "details", title: "Ijrochi rekvizitlari", blocks: [{ slot: "details" }] },
      ],
    },
    privacy: {
      title: "Maxfiylik siyosati",
      description: "{app} qanday shaxsga doir ma’lumotlarni yig‘adi, nima uchun, ularni qanday saqlaydi va himoya qiladi, kimga beradi va ularni qanday o‘chirish mumkin.",
      lead: "{site} sayti foydalanuvchilari va mehmonlarining shaxsga doir ma’lumotlarini qanday qayta ishlashimiz haqida.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "Umumiy qoidalar",
          blocks: [
            "Ushbu Siyosat {executor} (keyingi o‘rinlarda — «biz») {site} saytida, Telegramdagi {app} mini-ilovasi va botida (keyingi o‘rinlarda — «Servis») shaxsga doir ma’lumotlarni qanday qayta ishlashini tavsiflaydi.",
            "Biz shaxsga doir ma’lumotlarni O‘zbekiston Respublikasining 2019-yil 2-iyuldagi O‘RQ-547-son «Shaxsga doir ma’lumotlar to‘g‘risida»gi Qonuniga muvofiq qayta ishlaymiz.",
            "Servisdan foydalanib, siz Siyosatga rozilik bildirasiz. Agar rozi bo‘lmasangiz, Servisdan foydalanmang.",
          ],
        },
        {
          id: "collect",
          title: "Qanday ma’lumotlarni yig‘amiz",
          blocks: [
            "Taklifnoma yaratadigan foydalanuvchilar ma’lumotlari:",
            {
              list: [
                "telefon raqami — SMS orqali kelgan kod bilan kirish uchun va akkaunt identifikatori sifatida;",
                "Telegram orqali kirganda Telegram ma’lumotlari: ID, ism, familiya, foydalanuvchi nomi (username) va til;",
                "profildagi ism, interfeys tili, buyurtmalar va obuna haqidagi ma’lumotlar: buyurtma raqami, summa, holat, to‘lov vaqti.",
              ],
            },
            "Taklifnomalar mazmuni: ismlar, tadbir sanasi, vaqti va joyi, matnlar, dastur, tashkilotchi kontaktlari, yuklangan fotosuratlar, video va musiqa.",
            "Tashkilotchi yoki mehmonning o‘zi qo‘shadigan mehmonlar ma’lumotlari: ism, telefon raqami, guruh va o‘tirish tartibidagi stol, taklifnomaga javob (keladimi, necha kishi, ovqatlanish bo‘yicha istaklar, tashkilotchiga xabar), taklifnoma ochilgan vaqt va kelganlik belgisi. Agar mehmon botga yozsa, eslatmalar yuborish uchun uning Telegramdagi chat ID raqamini saqlaymiz.",
            "Texnik ma’lumotlar: IP-manzil, brauzer haqidagi ma’lumotlar (User-Agent), so‘rovlar vaqti. Ular Servisning ishlashi va himoyasi uchun kerak.",
            "Bank kartasining to‘liq raqami, amal qilish muddati va xavfsizlik kodini biz olmaymiz va saqlamaymiz: ular to‘lov tizimi sahifasida kiritiladi.",
          ],
        },
        {
          id: "purposes",
          title: "Ma’lumotlarni nima uchun qayta ishlaymiz",
          blocks: [
            "Biz ma’lumotlardan quyidagilar uchun foydalanamiz:",
            {
              list: [
                "akkaunt yaratish, sizni unga kiritish va taklifnomalaringizni saqlash;",
                "taklifnomalarni e’lon qilish va ularni mehmonlarga havola, SMS yoki Telegram orqali yetkazish;",
                "mehmonlarning javoblarini yig‘ish, ularni tashkilotchiga ko‘rsatish va unga bildirishnomalar yuborish;",
                "to‘lovlarni qabul qilish va buyurtmalarni bajarish;",
                "murojaatlarga javob berish;",
                "Servisni suiiste’mol va nosozliklardan himoya qilish;",
                "qonunchilik talablarini bajarish.",
              ],
            },
            "Biz shaxsga doir ma’lumotlarni sotmaymiz va ularni reklama tarqatish uchun ishlatmaymiz.",
          ],
        },
        {
          id: "basis",
          title: "Huquqiy asoslar",
          blocks: [
            "Foydalanuvchilar ma’lumotlarini ular Servisga kirganda beradigan rozilik asosida va [ommaviy oferta](oferta) bo‘yicha shartnomani bajarish uchun qayta ishlaymiz.",
            "Mehmonlar ma’lumotlarini tashkilotchi qo‘shadi va mehmonlar taklifnoma olishga rozi ekanligini tasdiqlaydi. Biz bu ma’lumotlarni faqat taklifnomani yetkazish va javoblarni yig‘ish uchun qayta ishlaymiz. Taklifnomaga o‘zi javob bergan mehmon o‘zi ko‘rsatgan ma’lumotlar qayta ishlanishiga rozilik bildiradi.",
            "To‘lovlar haqidagi ma’lumotlarni qonunchilik talab qilgani uchun saqlaymiz.",
          ],
        },
        {
          id: "storage",
          title: "Saqlash va himoya",
          blocks: [
            "Ma’lumotlar Servisning himoyalangan serverlarida saqlanadi, sayt faqat himoyalangan HTTPS protokoli orqali ishlaydi. Serverlar va ma’lumotlar bazalariga faqat Servis administratorlari kira oladi.",
            "Mehmonlarning shaxsiy havolalarida tasodifiy kalit bor, taklifnoma sahifalari qidiruv tizimlaridan yopilgan, tashkilotchi esa taklifnomani parol bilan himoya qilishi mumkin.",
            "Yuklangan fotosuratlar, video va musiqa kirishsiz to‘g‘ridan-to‘g‘ri havola orqali ochiladi: mehmonlar ularni taklifnoma sahifasida shunday ko‘radi.",
          ],
        },
        {
          id: "sharing",
          title: "Ma’lumotlarni kimga beramiz",
          blocks: [
            "Ma’lumotlarni faqat xizmat ko‘rsatishga yordam beradiganlarga va faqat kerakli hajmda beramiz:",
            {
              list: [
                "Eskiz (SMS-provayder) — telefon raqami va SMS matni: kirish kodlari, mehmonlarga taklifnomalar va eslatmalar;",
                "Multicard (to‘lov tizimi) — buyurtma raqami, summa va xarid tavsifi; karta ma’lumotlarini Multicard sahifasida o‘zingiz kiritasiz;",
                "Telegram — siz yoki mehmoningiz bot yoki mini-ilovadan foydalansangiz, bot xabarlari;",
                "Anthropic (AQSH) — faqat tashkilotchi yordamchidan taklifnoma matnini yozishni so‘raganda: tadbir turi, ismlar, sana va joy;",
                "Google, Unsplash va Telegram — sayt sahifalari Google Fonts shriftlarini, Unsplash saytidan namuna fotosuratlarni va Telegram mini-ilovasi skriptini, taklifnoma sahifasi esa joy manzili ko‘rsatilgan Google Maps xaritasini yuklaydi, shuning uchun bu servislar brauzerning IP-manzilini oladi.",
              ],
            },
            "Ushbu ro‘yxatdagi xorijiy servislarga (Telegram, Anthropic, Google, Unsplash) ma’lumotlar faqat tavsiflangan hajmda uzatiladi.",
            "Mehmonlar tashkilotchi taklifnomaga joylagan narsalarni ko‘radi. Agar tashkilotchi «Kimlar keladi» ro‘yxatini yoqqan bo‘lsa, mehmonlar «ha» deb javob berganlarning ismi va familiyasining birinchi harfini ko‘radi; «Mehmonlar kitobi»dagi tilaklarni taklifnomani ochgan har bir kishi ko‘radi.",
            "Davlat organlariga ma’lumotlarni faqat O‘zbekiston Respublikasi qonunchiligida nazarda tutilgan asoslar bo‘yicha oshkor qilamiz.",
          ],
        },
        {
          id: "retention",
          title: "Saqlash muddatlari",
          blocks: [
            "Ma’lumotlarni kerakli muddatdan ortiq saqlamaymiz:",
            {
              list: [
                "akkaunt va taklifnomalar ma’lumotlari — akkaunt mavjud ekan; hech narsa to‘lanmagan, obuna yoki bepul foydalanish huquqi orqali olinmagan va to‘lovi boshlanmagan qoralama o‘chirilganda unga yuklangan fayllar bilan birga darhol o‘chiriladi (boshqa taklifnomalaringizda bor fayllardan tashqari), qolgan o‘chirilgan taklifnomalar esa arxivga o‘tkaziladi va mehmonlarga boshqa ochilmaydi;",
                "mehmonlar ma’lumotlari — tashkilotchi mehmonni yoki taklifnomani o‘chirmaguncha; taklifnoma o‘chirilganda, jumladan arxivga o‘tkazilganda, uning mehmonlari darhol o‘chiriladi;",
                "SMS jurnali — har bir SMS yuborilgan telefon raqami, yuborish vaqti va holati: yuborishlarni SMS-provayder bilan solishtirish va Servisni suiiste’moldan himoya qilish uchun; kirish kodi yozilgan SMS matnini saqlamaymiz, mehmonlarga yuborilgan SMS raqami va matni (mehmon ismi va shaxsiy havolasi bilan) esa tashkilotchi mehmonni yoki taklifnomani o‘chirishi bilanoq, jumladan arxivga o‘tkazganda, o‘chiriladi;",
                "buyurtmalar va to‘lovlar haqidagi ma’lumotlar — buxgalteriya hisobi va soliqlar to‘g‘risidagi qonunchilikda belgilangan muddatlardan kam bo‘lmagan muddat;",
                "texnik jurnallar — Servisni himoya qilish uchun zarur bo‘lgan cheklangan muddat.",
              ],
            },
            "Muddat tugaganda yoki siz ma’lumotlarni o‘chirishni so‘raganingizda, ularni o‘chiramiz yoki shaxssizlashtiramiz.",
          ],
        },
        {
          id: "rights",
          title: "Sizning huquqlaringiz",
          blocks: [
            "Siz quyidagilarga haqlisiz:",
            {
              list: [
                "qaysi ma’lumotlaringiz va nima uchun qayta ishlanayotganini bilish va ularning nusxasini olish;",
                "noto‘g‘ri ma’lumotlarni tuzatishni talab qilish;",
                "rozilikni qaytarib olish va ma’lumotlarni o‘chirishni talab qilish; to‘lovlar haqidagi ma’lumotlarni qonun talab qilgan muddatgacha saqlaymiz;",
                "harakatlarimiz ustidan shaxsga doir ma’lumotlar sohasidagi vakolatli davlat organiga yoki sudga shikoyat qilish.",
              ],
            },
            "Huquqlardan foydalanish uchun akkauntga bog‘langan telefon raqami yoki Telegramdan [kontaktlar](contacts) orqali bizga yozing. So‘rovni siz yuborganingizni tasdiqlashni so‘rashimiz mumkin va qonunchilikda belgilangan muddatlarda javob beramiz.",
            "Mehmon o‘z ma’lumotlarini o‘chirishni taklifnoma tashkilotchisidan yoki bizdan so‘rashi mumkin: biz ularni taklifnomadan o‘chiramiz.",
          ],
        },
        {
          id: "cookies",
          title: "Cookie va brauzer xotirasi",
          blocks: [
            "Biz faqat zarur cookie fayllaridan foydalanamiz: sessiya cookie fayli saytga kirishni 30 kungacha yoki chiqqunga qadar saqlaydi, yana bittasi Telegram orqali kirish davomidagina amal qiladi.",
            "Brauzer xotirasida (localStorage) interfeys tili va mavzusi, tugallanmagan Telegram orqali kirish va to‘lov, konstruktorning oxirgi ochilgan qadami, mehmonda esa uni o‘zgartirish mumkin bo‘lishi uchun taklifnomaga bergan javobi saqlanadi.",
            "Saytda uchinchi tomon servislarining reklama va tahliliy cookie fayllari yo‘q.",
          ],
        },
        {
          id: "changes",
          title: "Siyosatdagi o‘zgarishlar",
          blocks: ["Biz Siyosatni yangilashimiz mumkin. Yangi tahrir ushbu sahifada sana bilan e’lon qilinadi va e’lon qilingan paytdan boshlab amal qiladi."],
        },
        {
          id: "operator",
          title: "Operator va kontaktlar",
          blocks: ["Shaxsga doir ma’lumotlar bo‘yicha savollar va o‘chirish so‘rovlarini [kontaktlar](contacts) orqali yuboring.", { slot: "details" }],
        },
      ],
    },
    contacts: {
      title: "Kontaktlar",
      description: "{app} bilan qanday bog‘lanish mumkin: Telegram, telefon, elektron pochta va rekvizitlar.",
      lead: "Har qanday savol bo‘yicha yozing: taklifnoma yaratish, to‘lov va pulni qaytarish, ma’lumotlarni o‘chirish.",
      numbered: false,
      sections: [
        {
          id: "write",
          title: "Biz bilan bog‘lanish",
          blocks: [{ slot: "contacts" }, "To‘lov va pulni qaytarish bo‘yicha savollarda buyurtma raqami va akkaunt telefon raqamini ko‘rsating."],
        },
        { id: "details", title: "Rekvizitlar", blocks: [{ slot: "company" }] },
        {
          id: "docs",
          title: "Hujjatlar",
          blocks: [
            {
              list: [
                "[Ommaviy oferta](oferta) — xizmat ko‘rsatish va pulni qaytarish shartlari.",
                "[Maxfiylik siyosati](privacy) — shaxsga doir ma’lumotlarni qanday qayta ishlashimiz.",
              ],
            },
          ],
        },
      ],
    },
  },
};

const en: LegalTexts = {
  ui: {
    revision: "Version of {date}",
    toc: "Contents",
    home: "Back to the website",
    langLabel: "Language",
    docsLabel: "Documents",
    nav: { oferta: "Offer", privacy: "Privacy", contacts: "Contacts" },
    executor: "the administration of the {host} website",
    fields: {
      companyName: "Name",
      inn: "Taxpayer ID (INN)",
      address: "Address",
      phone: "Phone",
      email: "Email",
      telegram: "Telegram",
      bankName: "Bank",
      bankAccount: "Bank account",
      mfo: "Bank code (MFO)",
      director: "Director",
      site: "Website",
      bot: "Telegram bot",
    },
    note: "This English text is provided for convenience. If it differs from the Russian or Uzbek version, those versions prevail.",
  },
  docs: {
    oferta: {
      title: "Public offer",
      description: "Terms of {app} services: creating and publishing online invitations, prices, card payments via Multicard, refunds and company details.",
      lead: "Agreement for the creation and publication of online invitations on {site}.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "General provisions",
          blocks: [
            "This document is a public offer: {executor} (the “Provider”) offers any person with full legal capacity (the “Customer”) to conclude a service agreement on the terms below.",
            "The offer is addressed to an unlimited number of persons and is published on {site}. The agreement is concluded when the offer is accepted.",
            "Terms used in this offer:",
            {
              list: [
                "“Website” — the {site} website as well as the {app} mini app and bot in Telegram;",
                "“Service” — the Website software for creating, publishing and sending invitations;",
                "“Invitation” — an online page about an event that the Customer creates on the Website from one of the templates;",
                "“Guest” — a person to whom the Customer sends an Invitation;",
                "“Seat” — a personal link to an Invitation for one Guest;",
                "“Subscription” — access to all Website templates for the paid period;",
                "“Order” — a Service the Customer has selected and paid for on the Website.",
              ],
            },
          ],
        },
        {
          id: "subject",
          title: "Subject of the agreement",
          blocks: [
            "The Provider gives the Customer access to the Service and provides services for creating and publishing online invitations (the “Services”), and the Customer pays for them on the terms of this offer.",
            "On the Website you can pay for:",
            {
              list: [
                "publishing an Invitation with one shared link for all Guests — paid per template;",
                "personal Invitations: each Guest gets their own link and their reply goes straight to the Customer’s list — paid per Seat; if SMS sending is available for the template, Guests can also receive the invitation by SMS;",
                "a Subscription for the period chosen at payment: any templates without a separate payment, Seats are paid separately.",
              ],
            },
            "Creating drafts, choosing templates and previewing are free.",
            "The Services are provided online; no physical media are delivered.",
          ],
        },
        {
          id: "acceptance",
          title: "Acceptance and placing an Order",
          blocks: [
            "The offer is accepted by paying for an Order on the Website. By paying, the Customer confirms that they have read this offer and the [Privacy policy](privacy) and accept them in full without reservations.",
            "To place an Order, the Customer signs in to the Website with a phone number or Telegram and chooses a template, a publishing option and, for personal Invitations, the number of Seats.",
            "If the Provider has given the Customer free access, Orders are fulfilled without payment and the other terms of this offer still apply.",
          ],
        },
        {
          id: "payment",
          title: "Prices and payment",
          blocks: [
            "Prices are shown on the Website in Uzbek soums. The price shown on the Website at the moment of payment applies.",
            "The Provider may change prices. New prices do not apply to Orders that are already paid.",
            "Payment is accepted by bank cards through the Multicard payment system; the accepted card types are shown on the payment page. The Customer enters card details on the payment system’s page; the Provider does not receive or store the full card number, expiry date or security code.",
            "An Order is paid once the payment system confirms the payment. The fiscal receipt is issued by the payment system as required by the laws of the Republic of Uzbekistan.",
            "A Subscription does not renew automatically: there are no repeat charges without the Customer’s action.",
          ],
        },
        {
          id: "delivery",
          title: "Provision of the Services",
          blocks: [
            "A Service is provided when, after the payment is confirmed, the Website unlocks what was paid for: the Invitation can be published or is already published, Seats are added to the Invitation, or the Subscription is active. This usually happens right after payment.",
            "A Subscription lasts the paid number of months from the moment of payment. If a Subscription is already active at that moment, the new period is added to it.",
            "A published Invitation opens by its link until the Customer deletes it: a deleted Invitation is moved to the archive and no longer opens for Guests, and its Guest list and replies are deleted.",
            "The Customer may change the content of a published Invitation; Guests see the changes immediately.",
            "Delivery of SMS and Telegram messages depends on mobile operators and Telegram. The Provider does not guarantee that a Guest will read or answer the invitation.",
          ],
        },
        {
          id: "refunds",
          title: "Refunds",
          blocks: [
            "Until the paid Invitation is published, the Customer may cancel the Service and get a full refund. For a Subscription this applies until any Invitation has been published under it.",
            "After publication the Service is considered provided. Refunds are made in the cases provided for by the laws of the Republic of Uzbekistan, including when the Service was not properly provided through the Provider’s fault.",
            "If a payment went through but access was not unlocked, the Provider will fulfil the Order or refund the payment in full.",
            "Send refund requests through the [Provider’s contacts](contacts) with the Order number and the account phone number. The Provider reviews a request within 10 working days.",
            "Money is returned to the card used for payment through the payment system; when it arrives depends on the bank that issued the card. After a refund, the Provider may close access to what was paid for (template, Seats or Subscription).",
          ],
        },
        {
          id: "duties",
          title: "Rights and obligations",
          blocks: [
            "The Provider undertakes to:",
            {
              list: [
                "unlock the paid features of the Service for the Customer;",
                "keep the Website running and fix failures within a reasonable time;",
                "answer the Customer’s requests;",
                "process personal data in accordance with the [Privacy policy](privacy).",
              ],
            },
            "The Customer undertakes to:",
            {
              list: [
                "provide accurate information and not share account access with other people;",
                "not place in Invitations any materials that violate the laws of the Republic of Uzbekistan or the rights of others, including copyright in texts, photos, videos and music;",
                "add Guests’ names and phone numbers only with their consent and use them to invite people to events, not for advertising;",
                "not disrupt the Website or circumvent the Service’s limits.",
              ],
            },
            "The Provider may unpublish an Invitation or suspend access to the account if the Customer violates this offer or the law.",
          ],
        },
        {
          id: "liability",
          title: "Liability",
          blocks: [
            "The Customer is responsible for the content of their Invitations, including uploaded materials, and for having the right to provide Guests’ data to the Service.",
            "The Provider is not responsible for the content of Invitations created by the Customer or for failures of third-party services: mobile operators, Telegram, the payment system, internet providers.",
            "The Provider’s liability to the Customer is limited to the amount paid for the relevant Order, unless the law provides otherwise.",
            "The parties are released from liability for failure to perform their obligations due to force majeure.",
          ],
        },
        {
          id: "availability",
          title: "Service availability",
          blocks: [
            "The Service works around the clock except during maintenance and failures. The Provider tries to carry out maintenance so that published Invitations stay available.",
            "The Provider may change the design and features of the Service without making Services already paid for worse.",
            "The Customer is advised to keep their own copies of uploaded photos, videos and music.",
          ],
        },
        {
          id: "data",
          title: "Personal data",
          blocks: [
            "The Provider processes the personal data of the Customer and Guests under the Law of the Republic of Uzbekistan “On Personal Data” and the [Privacy policy](privacy).",
            "By adding Guests’ data, the Customer confirms that the Guests agree to receive the invitation, including by SMS or in Telegram, and to have their data processed for this purpose.",
          ],
        },
        {
          id: "changes",
          title: "Term and changes",
          blocks: [
            "The agreement is valid from acceptance until the obligations are fully performed.",
            "The Provider may change this offer by publishing a new version on this page. The new version applies from publication; Orders paid earlier are governed by the version in force at the moment of payment.",
          ],
        },
        {
          id: "law",
          title: "Governing law and disputes",
          blocks: [
            "The agreement is governed by the laws of the Republic of Uzbekistan.",
            "The parties resolve disputes through negotiation. A claim can be sent through the [Provider’s contacts](contacts); the Provider answers within 10 working days. If no agreement is reached, the dispute is resolved in court as provided by the laws of the Republic of Uzbekistan.",
          ],
        },
        { id: "details", title: "Provider details", blocks: [{ slot: "details" }] },
      ],
    },
    privacy: {
      title: "Privacy policy",
      description: "What personal data {app} collects, why, how it is stored and protected, who receives it and how to delete it.",
      lead: "How we process the personal data of users and guests of {site}.",
      numbered: true,
      sections: [
        {
          id: "general",
          title: "General provisions",
          blocks: [
            "This policy describes how {executor} (“we”) processes personal data on {site} and in the {app} mini app and bot in Telegram (the “Service”).",
            "We process personal data under Law of the Republic of Uzbekistan No. ZRU-547 “On Personal Data” of 2 July 2019.",
            "By using the Service you agree to this policy. If you do not agree, please do not use the Service.",
          ],
        },
        {
          id: "collect",
          title: "What data we collect",
          blocks: [
            "Data of users who create invitations:",
            {
              list: [
                "phone number — to sign in with a code from SMS and as the account identifier;",
                "Telegram data when you sign in with Telegram: ID, first and last name, username and language;",
                "the name in your profile, interface language, order and subscription details: order number, amount, status, payment time.",
              ],
            },
            "Invitation content: names, date, time and place of the event, texts, programme, the organiser’s contacts, uploaded photos, videos and music.",
            "Guest data added by the organiser or by the guest: name, phone number, group and table in the seating plan, the reply to the invitation (coming or not, number of people, dietary notes, message to the organiser), when the invitation was opened and the check-in mark. If a guest writes to the bot, we store their Telegram chat ID to send reminders.",
            "Technical data: IP address, browser details (User-Agent), request times. We need them to run and protect the Service.",
            "We do not receive or store the full bank card number, expiry date or security code: they are entered on the payment system’s page.",
          ],
        },
        {
          id: "purposes",
          title: "Why we process data",
          blocks: [
            "We use data to:",
            {
              list: [
                "create your account, sign you in and keep your invitations;",
                "publish invitations and deliver them to guests by link, SMS or Telegram;",
                "collect guests’ replies, show them to the organiser and send the organiser notifications;",
                "take payments and fulfil orders;",
                "answer requests;",
                "protect the Service from abuse and failures;",
                "comply with the law.",
              ],
            },
            "We do not sell personal data and do not use it for advertising.",
          ],
        },
        {
          id: "basis",
          title: "Legal grounds",
          blocks: [
            "We process users’ data with the consent they give when signing in to the Service and to perform the agreement under the [public offer](oferta).",
            "Guests’ data is added by the organiser, who confirms that the guests agree to receive the invitation. We process this data only to deliver the invitation and collect replies. A guest who replies to an invitation themselves consents to the processing of the data they provide.",
            "We keep payment records because the law requires it.",
          ],
        },
        {
          id: "storage",
          title: "Storage and protection",
          blocks: [
            "Data is stored on the Service’s protected servers, and the Website works only over secure HTTPS. Only the Service’s administrators have access to the servers and databases.",
            "Guests’ personal links contain a random key, invitation pages are hidden from search engines, and the organiser can protect an invitation with a password.",
            "Uploaded photos, videos and music open by direct link without signing in: this is how guests see them on the invitation page.",
          ],
        },
        {
          id: "sharing",
          title: "Who we share data with",
          blocks: [
            "We share data only with those who help us provide the service, and only as much as needed:",
            {
              list: [
                "Eskiz (SMS provider) — phone number and SMS text: sign-in codes, invitations and reminders to guests;",
                "Multicard (payment system) — order number, amount and purchase description; you enter card details on the Multicard page;",
                "Telegram — bot messages, if you or your guest use the bot or the mini app;",
                "Anthropic (USA) — only when the organiser asks the assistant to write the invitation text: event type, names, date and venue;",
                "Google, Unsplash and Telegram — website pages load Google Fonts, sample photos from Unsplash and the Telegram mini app script, and the invitation page loads a Google Maps map with the venue address, so these services receive the browser’s IP address.",
              ],
            },
            "The foreign services on this list (Telegram, Anthropic, Google, Unsplash) receive data only to the extent described.",
            "Guests see what the organiser has put in the invitation. If the organiser has turned on the “Who is coming” list, guests see the first name and the initial of the last name of those who replied “yes”; guestbook wishes are visible to everyone who opens the invitation.",
            "We disclose data to state authorities only on the grounds provided by the laws of the Republic of Uzbekistan.",
          ],
        },
        {
          id: "retention",
          title: "Retention",
          blocks: [
            "We keep data no longer than needed:",
            {
              list: [
                "account and invitation data — while the account exists; a deleted draft with nothing paid for or received through a subscription or free access, and no payment started, is deleted immediately together with the files uploaded to it (except those used in your other invitations), while other deleted invitations are moved to the archive and no longer open for guests;",
                "guest data — until the organiser deletes the guest or the invitation; when an invitation is deleted, including when it is moved to the archive, its guests are deleted right away;",
                "SMS log — the phone number, time and status of each message, to reconcile messages with the SMS provider and protect the Service from abuse; we do not store the text of login code messages, and for messages to guests the number and text (with the guest’s name and personal link) are erased as soon as the organiser deletes the guest or the invitation, including when it is moved to the archive;",
                "order and payment records — for no less than the periods set by accounting and tax laws;",
                "technical logs — for a limited time needed to protect the Service.",
              ],
            },
            "When the period ends or you ask us to delete your data, we delete or anonymise it.",
          ],
        },
        {
          id: "rights",
          title: "Your rights",
          blocks: [
            "You have the right to:",
            {
              list: [
                "know what data of yours we process and why, and get a copy of it;",
                "ask us to correct inaccurate data;",
                "withdraw consent and ask us to delete your data; payment records are kept as long as the law requires;",
                "complain about our actions to the authorised state body for personal data or to a court.",
              ],
            },
            "To exercise your rights, write to us through the [contacts](contacts) from the phone number or Telegram linked to your account. We may ask you to confirm that the request is yours and will answer within the time limits set by law.",
            "A guest may ask the invitation’s organiser or us to delete their data: we will remove it from the invitation.",
          ],
        },
        {
          id: "cookies",
          title: "Cookies and browser storage",
          blocks: [
            "We use only necessary cookies: the session cookie keeps you signed in for up to 30 days or until you sign out, and another one works only while you sign in with Telegram.",
            "Browser storage (localStorage) keeps the interface language and theme, an unfinished Telegram sign-in or payment, the last open builder step, and for guests their reply to the invitation so they can change it.",
            "The Website has no advertising or analytics cookies from third-party services.",
          ],
        },
        {
          id: "changes",
          title: "Changes to this policy",
          blocks: ["We may update this policy. The new version is published on this page with its date and applies from publication."],
        },
        {
          id: "operator",
          title: "Operator and contacts",
          blocks: ["Send questions about personal data and deletion requests through the [contacts](contacts).", { slot: "details" }],
        },
      ],
    },
    contacts: {
      title: "Contacts",
      description: "How to reach {app}: Telegram, phone, email and company details.",
      lead: "Write to us about anything: creating an invitation, payment and refunds, deleting data.",
      numbered: false,
      sections: [
        {
          id: "write",
          title: "Get in touch",
          blocks: [{ slot: "contacts" }, "For payment and refund questions, include the order number and the account phone number."],
        },
        { id: "details", title: "Company details", blocks: [{ slot: "company" }] },
        {
          id: "docs",
          title: "Documents",
          blocks: [
            {
              list: [
                "[Public offer](oferta) — terms of service and refunds.",
                "[Privacy policy](privacy) — how we process personal data.",
              ],
            },
          ],
        },
      ],
    },
  },
};

// Подстановки {…}, цели ссылок «](privacy)», названия сервисов и технические слова остаются латиницей.
const KEEP_LATIN =
  /(\{\w+\}|\]\(\w+\)|\b(?:Multicard|Eskiz|Uzcard|Humo|Telegram|Invito|Anthropic|Unsplash|Google Maps|Google Fonts|Google|HTTPS|User-Agent|username|localStorage|[Cc]ookie|ID|IP)\b)/;
const cyr = (s: string) =>
  s
    .split(KEEP_LATIN)
    .map((part, i) => (i % 2 ? part : toCyr(part)))
    .join("");
const cyrDeep = <T>(v: T): T =>
  (typeof v === "string"
    ? cyr(v)
    : Array.isArray(v)
      ? v.map(cyrDeep)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" || k === "slot" || k === "numbered" ? x : cyrDeep(x)]))
        : v) as T;

export const legalTexts: Record<Locale, LegalTexts> = { ru, uz, uzc: cyrDeep(uz), en };
