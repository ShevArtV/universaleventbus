<?php
/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Подключите этот плагин к событиям которые хотите передать на фронт.
 * @var \modX $modx
 * @var array $scriptProperties
 */

use UniversalEventBus\Services\EventBus;

$basePath = $modx->getOption('base_path', null, $_SERVER['DOCUMENT_ROOT'] . '/');
require_once $basePath . 'core/components/universaleventbus/services/vendor/autoload.php';
$EventBus = new EventBus($modx, $scriptProperties);
if($modx->event->name === 'OnLoadWebDocument') {
    $EventBus->loadJS($modx->resource->template);
}
if($modx->event->name !== 'OnCacheUpdate') {
    $EventBus->handleEvent($modx->event->name);
}else{
    $EventBus->cleanCache();
}
