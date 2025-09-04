<?php
/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Плагин для подключения UniversalEventBus.
 * @var \modX $modx
 * @var array $scriptProperties
 */

use UniversalEventBus\EventBus;

$basePath = $modx->getOption('base_path', null, $_SERVER['DOCUMENT_ROOT'] . '/');
require_once $basePath . 'core/components/universaleventbus/services/vendor/autoload.php';
$EventBus = new EventBus($modx, $scriptProperties);

switch ($modx->event->name) {
    case 'OnLoadWebDocument':
        $EventBus->setContextCookie();
        $EventBus->loadJS($modx->resource->template);
        break;
    case 'OnCacheUpdate':
        $EventBus->cleanCache();
        break;
    case 'msOnCreateOrder':
        $_SESSION['ueb']['orderId'] = $scriptProperties['msOrder']->get('id');
        break;
}
