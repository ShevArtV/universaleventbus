--------------------
UniversalEventBus
--------------------
Author: Shevchenko Artur <shev.art.v@yandex.ru>
--------------------

UniversalEventBus - компонент для отправки серверных событий на фронт и событий фронта на сервер.

Как пользоваться:
1. Создать в админке плагин с любым именем и подключить его к нужным событиям.
<code>
use UniversalEventBus\Services\EventBus;

$basePath = $modx->getOption('base_path', null, $_SERVER['DOCUMENT_ROOT'] . '/');
require_once $basePath . 'core/components/universaleventbus/services/vendor/autoload.php';

$eventBus = new EventBus($modx);
$eventBus->sendEvent($modx->event->name);
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

--------------------
GitHub: https://github.com/ShevArtV/universaleventbus
