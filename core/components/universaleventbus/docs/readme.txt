--------------------
UniversalEventBus
--------------------
Author: Shevchenko Artur <shev.art.v@yandex.ru>
--------------------

UniversalEventBus - компонент для отправки серверных событий на фронт и событий фронта на сервер.

Транспорт server→browser работает полностью на текущем MODX-сервере, без внешних
realtime-сервисов. В режиме adaptive активная вкладка держит ограниченное по времени
SSE-соединение, после периода бездействия закрывает его и переходит на короткие cursor-запросы
с увеличивающимся интервалом. Скрытая вкладка запросов не выполняет. При активности или
получении события SSE открывается снова. Несколько вкладок используют один сетевой transport
через BroadcastChannel.

Cursor-события хранятся с TTL в локальной таблице <prefix>ueb_events. PHP-сессия закрывается
до начала SSE-цикла и не блокирует корзину, checkout и другие AJAX-запросы.
Событие не удаляется при первом подтверждении cursor: до истечения TTL его может дочитать
следующая страница или вкладка, которая ещё не сохранила cursor лидирующей вкладки.

Как пользоваться:
1. Создать в админке плагин с любым именем и подключить его к нужным событиям.
<code>
use UniversalEventBus\EventBus;

$basePath = $modx->getOption('base_path', null, $_SERVER['DOCUMENT_ROOT'] . '/');
require_once $basePath . 'core/components/universaleventbus/services/vendor/autoload.php';

$eventBus = new EventBus($modx);
$eventBus->handleEvent($modx->event->name);
</code>

2. В JavaScript нужно ловить событие "eventbus" и в обработчике выполнять необходимое действие.
<code>
document.addEventListener('eventbus', (event) => {
    console.log(event.detail.data);
});
</code>

3. Вы можете передавать на сервер информацию о браузерных событиях. Например, для передачи на сервер информации о клике по ссылке
<code>
<a href="{$uri}" data-ueb-event="click" data-ueb-once="1" data-ueb-params="rid:{$id};eventName:productClick">{$menutitle}</a>
</code>
Атрибут data-ueb-once указывает на то, что событие будет отправлено только один раз.

Доступны нестандартные значения для атрибута data-ueb-event:
- close/open - установите его элементам которые должны закрыться/открыться
- show/hide - установите его элементам которые должны появляться/исчезать (например при скролле)
При использовании событий close/open у целевых элементов должны меняться классы отвечающие за показ/скрытие
 и эти классы надо перечислить в системных настройках.

В атрибуте data-ueb-params можно указать произвольные параметры, которые будут переданы в событие на сервер.

4. Вы можете добавить обработчик события eventbus:before:send и добавить любые данные для передачи на сервер
<code>
    document.addEventListener('eventbus:before:send', (event) => {
       const {target, params} = event.detail;
       if(target.id === '#product-1') {
            params.append('product_id', 1);
       }
    });
</code>

Системные события:
- OnUebInit (после инициализации компонента): $EventBus
- OnBeforeUebHandleEvent (перед получением данные и добавления в очередь): $EventBus, $dispatch
- OnUebHandleEvent (после получения данных, но перед добавлением в очередь): $output, $EventBus
- OnUebGetProductsData (получение данных о товаре): $product, $EventBus.
- OnGetUebWebConfig (получение конфигурации фронтенда): $webConfig, $EventBus.

Вы можете отменить добавление события в очередь в плагине: $EventBus->dispatch = false.
Вы можете изменить данные перед отправкой в очередь в плагине: $EventBus->output = [];
Вы можете изменить данные товара в плагине: $EventBus->product = [];
Вы можете изменить конфигурации фронтенда в плагине: $EventBus->webConfig = [];
Вы можете изменить получателя в плагине: $EventBus->branch = 'branch_name';
Вы можете изменить получателя при инициализации: $EventBus = new EventBus($modx, ['branch' => 'branch_name']);

Основные настройки adaptive transport:
- ueb_transport: adaptive или legacy;
- ueb_stream_duration: максимальная длительность одного SSE-запроса, секунды;
- ueb_stream_heartbeat: интервал heartbeat, секунды;
- ueb_stream_read_interval: интервал проверки EventStore внутри SSE, миллисекунды;
- ueb_stream_idle_timeout: таймаут перехода активной вкладки в cursor polling, миллисекунды;
- ueb_cursor_poll_initial / ueb_cursor_poll_max: границы backoff cursor polling, миллисекунды;
- ueb_event_ttl: срок хранения недоставленного события, секунды;
- ueb_event_batch_size: максимум событий за одно чтение;
- ueb_navigation_timeout: максимальная задержка перехода по обычной ссылке, пока браузерное событие записывается на сервер, миллисекунды.

Для обычного клика по ссылке с data-ueb-event="click" переход выполняется после ответа
action.php либо по истечении ueb_navigation_timeout. Это закрывает гонку, при которой браузер
мог отменить fetch во время выгрузки страницы. Перед отправкой текущая страница закрывает
свой transport, поэтому событие дочитывает уже следующая страница. Ссылки с модификаторами,
download, target не равным _self и переходы только по hash не задерживаются.

Для того, чтобы в данных была информация о модификациях, нужно передать на сервер id модификации в параметре mid
или опции в параметре options, по которым можно получить модификацию.

--------------------
GitHub: https://github.com/ShevArtV/universaleventbus
