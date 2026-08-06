<?php

/**
 * Local adaptive transport: bounded SSE for active clients and one-shot cursor
 * reads for idle clients.
 *
 * @var \modX $modx
 */

use UniversalEventBus\EventBus;

$basePath = dirname(__FILE__, 5);
define('MODX_API_MODE', true);
require_once $basePath . '/index.php';
$modx->getService('error', 'error.modError');
$modx->setLogLevel(\modX::LOG_LEVEL_ERROR);

$autoloadPath = $modx->getOption(
    'ueb_autoload_path',
    null,
    '/core/components/universaleventbus/services/vendor/autoload.php'
);
$path = $basePath . $autoloadPath;
if (!is_file($path)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'UniversalEventBus autoload not found']);
    exit;
}
require_once $path;

$eventBus = new EventBus($modx, ['onReading' => true]);
$eventStore = $eventBus->eventstore;
$branch = $eventBus->branch;
$mode = isset($_GET['mode']) ? (string) $_GET['mode'] : 'stream';

if ($mode === 'legacy' || $modx->getOption('ueb_transport', null, 'adaptive') === 'legacy') {
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    $retry = (int) $modx->getOption('ueb_sse_retry', null, 5000);
    echo 'retry: ' . max(250, $retry) . "\n\n";

    $messages = $eventBus->queuemanager->getMessages($branch);
    $sentIds = !empty($_COOKIE['ueb_message_ids'])
        ? json_decode((string) $_COOKIE['ueb_message_ids'], true)
        : [];
    $sentIds = is_array($sentIds) ? $sentIds : [];
    $sessionMessages = !empty($_SESSION['ueb_messages']) && is_array($_SESSION['ueb_messages'])
        ? $_SESSION['ueb_messages']
        : [];
    foreach ($sessionMessages as $id => $message) {
        if (array_key_exists($id, $sentIds)) {
            unset($sessionMessages[$id]);
        }
    }
    $_SESSION['ueb_messages'] = array_merge($sessionMessages, $messages);
    foreach ($_SESSION['ueb_messages'] as $id => $message) {
        echo 'id: ' . $id . "\n";
        echo 'data: ' . $message . "\n\n";
    }
    flush();
    exit;
}

// The stream must never block cart, checkout or another AJAX request that uses
// the same MODX/PHP session.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

$cursor = isset($_GET['cursor']) ? (int) $_GET['cursor'] : 0;
if ($cursor <= 0 && !empty($_SERVER['HTTP_LAST_EVENT_ID'])) {
    $cursor = (int) $_SERVER['HTTP_LAST_EVENT_ID'];
}
$cursor = max(0, $cursor);
$cursor = $eventStore->normalizeCursor($branch, $cursor);
$limit = (int) $modx->getOption('ueb_event_batch_size', null, 100);
$limit = max(1, min(1000, $limit));

// Events remain replayable until TTL: another page or a follower tab may not
// have persisted the leader tab's cursor yet. Deleting on the first client's
// acknowledgement would create a navigation/multi-tab delivery race.
$eventStore->cleanupExpired(500);

if ($mode === 'poll') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    $events = $eventStore->readAfter($branch, $cursor, $limit);
    $nextCursor = $cursor;
    foreach ($events as $event) {
        $nextCursor = max($nextCursor, (int) $event['cursor']);
    }
    echo json_encode([
        'success' => true,
        'cursor' => $nextCursor,
        'events' => $events,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($mode !== 'stream') {
    http_response_code(400);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Unsupported transport mode']);
    exit;
}

header('Content-Type: text/event-stream; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Connection: keep-alive');
header('X-Accel-Buffering: no');

$retry = (int) $modx->getOption('ueb_sse_retry', null, 1000);
$duration = (int) $modx->getOption('ueb_stream_duration', null, 30);
$heartbeat = (int) $modx->getOption('ueb_stream_heartbeat', null, 10);
$readInterval = (int) $modx->getOption('ueb_stream_read_interval', null, 1000);

$retry = max(250, min(30000, $retry));
$duration = max(5, min(55, $duration));
$heartbeat = max(2, min($duration, $heartbeat));
$readInterval = max(250, min(5000, $readInterval));

$maxExecutionTime = (int) ini_get('max_execution_time');
if ($maxExecutionTime > 0) {
    $duration = max(5, min($duration, $maxExecutionTime - 2));
}

ignore_user_abort(false);
@set_time_limit($duration + 2);
while (ob_get_level() > 0) {
    @ob_end_flush();
}
ob_implicit_flush(true);

echo 'retry: ' . $retry . "\n\n";
echo ': stream-open ' . time() . str_repeat(' ', 2048) . "\n\n";
flush();

$startedAt = microtime(true);
$deadline = $startedAt + $duration;
$lastHeartbeatAt = $startedAt;

while (microtime(true) < $deadline && !connection_aborted()) {
    $events = $eventStore->readAfter($branch, $cursor, $limit);
    if (!empty($events)) {
        foreach ($events as $event) {
            $eventCursor = (int) $event['cursor'];
            $data = json_encode($event['data'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($eventCursor <= $cursor || $data === false) {
                continue;
            }
            echo 'id: ' . $eventCursor . "\n";
            echo 'data: ' . $data . "\n\n";
            $cursor = $eventCursor;
        }
        $lastHeartbeatAt = microtime(true);
        flush();
        continue;
    }

    $now = microtime(true);
    if (($now - $lastHeartbeatAt) >= $heartbeat) {
        echo ': heartbeat ' . time() . "\n\n";
        $lastHeartbeatAt = $now;
        flush();
    }

    usleep($readInterval * 1000);
}

echo "event: ueb-stream-end\n";
echo 'data: {"cursor":' . $cursor . "}\n\n";
flush();
