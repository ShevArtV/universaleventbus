<?php

/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Обработчик запросов с фронта для SSE.
 * @var \modX $modx
 */

use UniversalEventBus\EventBus;

header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');
header('Connection: keep-alive');

$basePath = dirname(__FILE__, 5);
define('MODX_API_MODE', true);
require_once $basePath . '/index.php';
$modx->getService('error', 'error.modError');
$modx->setLogLevel(\modX::LOG_LEVEL_ERROR);

$retry = $modx->getOption('ueb_sse_retry', null, 5000);
$autoloadPath = $modx->getOption('ueb_autoload_path', null, '/core/components/universaleventbus/services/vendor/autoload.php');

echo "retry: " . $retry . "\n\n";

$path = $basePath . $autoloadPath;
if (!file_exists($path)) {
    echo 'data: {"error":"File `autoload.php` not found"}' . "\n\n";
}
require_once $path;
$EventBus = new EventBus($modx, ['onReading' => true]);

/**
 * @param array $messages
 */
function sendMessages(array $messages): void
{
    foreach ($messages as $id => $message) {
        echo "id: " . $id . "\n\n";
        echo "data: " . $message . "\n\n";
        ob_flush();
        flush();
    }
}
$messages = $EventBus->queuemanager->getMessages($EventBus->branch);
$sendedIds = json_decode($_COOKIE['ueb_message_ids'], true) ?: [];

if(!empty($_SESSION['ueb_messages'])) {
    foreach ($_SESSION['ueb_messages'] as $id => $message) {
        if(in_array($id, array_keys($sendedIds)?:[])) {
            unset($_SESSION['ueb_messages'][$id]);
        }
    }
}else{
    $_SESSION['ueb_messages'] = [];
}
$_SESSION['ueb_messages'] = array_merge($_SESSION['ueb_messages'], $messages);

if (!empty($_SESSION['ueb_messages'])) {
    sendMessages($_SESSION['ueb_messages']);
}
