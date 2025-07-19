--------------------
UniversalEventBus
--------------------
Author: Shevchenko Artur <shev.art.v@yandex.ru>
--------------------

UniversalEventBus - компонент для отправки серверных событий на фронт.

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

Системные события:
- OnUebInit (после инициализации компонента): $EventBus
- OnBeforeUebHandleEvent (перед получением данные и добавления в очередь): $EventBus, $dispatch
- OnUebHandleEvent (после получения данных, но перед добавлением в очередь): $output, $EventBus
- OnUebGetProductsData (получение данных о товаре): $product, $EventBus.

Вы можете отменить добавление события в очередь в плагине: $EventBus->dispatch = false.
Вы можете изменить данные перед отправкой в очередь в плагине: $EventBus->output = [];
Вы можете изменить данные товара в плагине: $EventBus->product = [];

--------------------
GitHub: https://github.com/ShevArtV/universaleventbus
