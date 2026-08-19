<?php
/**
 * @var modxBuilder $this
 * @var string $categoryName
 * @var string $namespace
 *
 * Системные события пакета — точки интеграции для плагинов.
 *
 * ⚠️ Список статический и обязан совпадать с вызовами invokeEvent() в
 * services/custom/EventBus.php. Раньше события выбирались из БД стенда
 * (getCollection('modEvent', ['groupname' => $categoryName])), и пакет вёз в
 * реестр то, что кто-то завёл в его админке: OnUebGetProductData там не было
 * вовсе, зато лежало OnUebGetProductsData, которого нет в коде. Подписка на
 * незарегистрированное имя мертва молча — modX::getEventMap() строит карту через
 * INNER JOIN по modEvent, так что плагин просто не вызывается, без ошибки.
 *
 * OnUebInit              — после инициализации EventBus ($branch, $EventBus)
 * OnBeforeUebHandleEvent — перед сбором данных ($dispatch, $EventBus)
 * OnUebHandleEvent       — после сбора данных, перед очередью ($options, $output, $EventBus)
 * OnUebGetProductData    — при сборке данных товара ($product, $EventBus)
 * OnGetUebWebConfig      — при сборке конфигурации фронта ($webConfig, $object)
 */

$eventNames = array(
    'OnUebInit',
    'OnBeforeUebHandleEvent',
    'OnUebHandleEvent',
    'OnUebGetProductData',
    'OnGetUebWebConfig',
);

$events = array();

foreach ($eventNames as $eventName) {
    /** @var modEvent $event */
    $event = $this->modx->newObject('modEvent');
    $event->fromArray(array(
        'name' => $eventName,
        // 6 — сервис плагинов, как у всех событий, на которые подписываются плагины.
        'service' => 6,
        'groupname' => $categoryName,
    ), '', true, true);
    $events[] = $event;
}

unset($eventNames, $eventName, $event);

return $events;
