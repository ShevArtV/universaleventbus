<?php
/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Плагин для подключения UniversalEventBus.
 * @var \modX $modx
 * @var array $scriptProperties
 */

use UniversalEventBus\Services\EventBus;

$basePath = dirname(__FILE__, 5);
define('MODX_API_MODE', true);
require_once $basePath . '/index.php';
$modx->getService('error', 'error.modError');
$modx->setLogLevel(\modX::LOG_LEVEL_ERROR);

$autoloadPath = $modx->getOption('ueb_autoload_path', null, '/core/components/universaleventbus/services/vendor/autoload.php');

$path = $basePath . $autoloadPath;
if (!file_exists($path)) {
    $response = [
        'success' => false,
        'message' => "File `$autoloadPath` not found",
        'data' => []
    ];
    die(json_encode($response));
}
if (empty($_POST['eventName'])) {
    $response = [
        'success' => false,
        'message' => "No event name",
        'data' => []
    ];
    die(json_encode($response));
}
require_once $path;
$EventBus = new EventBus($modx, $_POST);
$EventBus->handleEvent($_POST['eventName']);
$response = [
    'success' => true,
    'message' => "Event added",
    'data' => $_POST
];
die(json_encode($response));
