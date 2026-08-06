<?php

/** @var xPDOTransport $transport */
/** @var array $options */
/** @var modX $modx */

if (!$transport->xpdo) {
    return false;
}

$modx =& $transport->xpdo;
$prefix = (string) $modx->getOption('table_prefix', null, 'modx_');
if (!preg_match('/^[a-zA-Z0-9_]+$/', $prefix)) {
    $modx->log(modX::LOG_LEVEL_ERROR, '[UniversalEventBus] Invalid table prefix');
    return false;
}

$table = '`' . $prefix . 'ueb_events`';

switch ($options[xPDOTransport::PACKAGE_ACTION]) {
    case xPDOTransport::ACTION_INSTALL:
    case xPDOTransport::ACTION_UPGRADE:
        $sql = "CREATE TABLE IF NOT EXISTS {$table} (
            `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            `branch_hash` CHAR(64) NOT NULL,
            `event_id` CHAR(32) NOT NULL,
            `payload` MEDIUMTEXT NOT NULL,
            `created_at` INT UNSIGNED NOT NULL,
            `expires_at` INT UNSIGNED NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `event_id` (`event_id`),
            KEY `branch_cursor` (`branch_hash`, `id`),
            KEY `expires_at` (`expires_at`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
        if ($modx->exec($sql) === false) {
            $modx->log(modX::LOG_LEVEL_ERROR, '[UniversalEventBus] Could not create cursor event store');
            return false;
        }
        break;

    case xPDOTransport::ACTION_UNINSTALL:
        if ($modx->exec("DROP TABLE IF EXISTS {$table}") === false) {
            $modx->log(modX::LOG_LEVEL_ERROR, '[UniversalEventBus] Could not drop cursor event store');
            return false;
        }
        break;
}

return true;
