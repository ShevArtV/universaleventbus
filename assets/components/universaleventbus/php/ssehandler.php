<?php

/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Обработчик запросов с фронта для SSE.
 * @var \modX $modx
 */

use UniversalEventBus\Services\EventBus;

header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');

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
        echo "data: " . $message . "\n\n";
        echo "id: " . $id . "\n\n";
        ob_flush();
        flush();
    }
}

if ($messages = $EventBus->queuemanager->getMessages($EventBus->branch)) {
    sendMessages($messages);
}
