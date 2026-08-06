<?php

namespace UniversalEventBus\Helpers;

/**
 * Local cursor-based storage for browser deliveries.
 *
 * The monotonically increasing database id is the transport cursor. The
 * public eventId remains part of the payload and is used for deduplication by
 * consumers.
 */
class EventStore
{
    /** @var \modX */
    private \modX $modx;

    /** @var string */
    private string $table;

    /** @var Logging */
    private Logging $logging;

    public function __construct(\modX $modx)
    {
        $this->modx = $modx;
        $this->logging = new Logging(
            $modx,
            (bool) $modx->getOption('ueb_debug', null, true),
            $modx->getOption('ueb_log_level', null, 'error')
        );

        $prefix = (string) $modx->getOption('table_prefix', null, 'modx_');
        if (!preg_match('/^[a-zA-Z0-9_]+$/', $prefix)) {
            throw new \RuntimeException('Invalid MODX table prefix');
        }
        $this->table = '`' . $prefix . 'ueb_events`';
    }

    /**
     * @return int|null Inserted cursor or null when the event was not stored.
     */
    public function publish(string $branch, array $payload, int $ttl): ?int
    {
        if ($branch === '' || empty($payload)) {
            $this->logging->write(__METHOD__, 'Branch or payload is empty', [], false, 'warning', 'queue');
            return null;
        }

        $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($encoded === false) {
            $this->logging->write(
                __METHOD__,
                'Could not encode event payload',
                ['json_error' => json_last_error_msg()],
                false,
                'error',
                'queue'
            );
            return null;
        }

        $now = time();
        $ttl = max(1, $ttl);
        $eventId = isset($payload['eventId']) ? (string) $payload['eventId'] : '';
        if ($eventId === '') {
            $eventId = bin2hex(random_bytes(16));
        }

        $sql = "INSERT INTO {$this->table}
            (`branch_hash`, `event_id`, `payload`, `created_at`, `expires_at`)
            VALUES (:branch_hash, :event_id, :payload, :created_at, :expires_at)
            ON DUPLICATE KEY UPDATE `id` = LAST_INSERT_ID(`id`)";
        $stmt = $this->modx->prepare($sql);
        if (!$stmt || !$stmt->execute([
            ':branch_hash' => $this->hashBranch($branch),
            ':event_id' => $eventId,
            ':payload' => $encoded,
            ':created_at' => $now,
            ':expires_at' => $now + $ttl,
        ])) {
            $this->logging->write(__METHOD__, 'Could not store event', [], false, 'error', 'queue');
            return null;
        }

        return (int) $this->modx->lastInsertId();
    }

    /**
     * @return array<int,array{cursor:int,eventId:string,data:array}>
     */
    public function readAfter(string $branch, int $cursor, int $limit = 100): array
    {
        if ($branch === '') {
            return [];
        }

        $limit = max(1, min(1000, $limit));
        $sql = "SELECT `id`, `event_id`, `payload`
            FROM {$this->table}
            WHERE `branch_hash` = :branch_hash
              AND `id` > :cursor
              AND `expires_at` >= :now
            ORDER BY `id` ASC
            LIMIT {$limit}";
        $stmt = $this->modx->prepare($sql);
        if (!$stmt || !$stmt->execute([
            ':branch_hash' => $this->hashBranch($branch),
            ':cursor' => max(0, $cursor),
            ':now' => time(),
        ])) {
            $this->logging->write(__METHOD__, 'Could not read events', [], false, 'error', 'queue');
            return [];
        }

        $events = [];
        while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
            $payload = json_decode((string) $row['payload'], true);
            if (!is_array($payload)) {
                $this->logging->write(
                    __METHOD__,
                    'Could not decode stored event',
                    ['cursor' => (int) $row['id']],
                    false,
                    'warning',
                    'queue'
                );
                continue;
            }
            $events[] = [
                'cursor' => (int) $row['id'],
                'eventId' => (string) $row['event_id'],
                'data' => $payload,
            ];
        }
        $stmt->closeCursor();

        return $events;
    }

    /**
     * A cursor is accepted only when it belongs to the current branch. This
     * prevents a stale sessionStorage cursor from acknowledging/skipping events
     * after PHP session regeneration or a custom branch switch.
     */
    public function normalizeCursor(string $branch, int $cursor): int
    {
        if ($branch === '' || $cursor <= 0) {
            return 0;
        }

        $sql = "SELECT `id` FROM {$this->table}
            WHERE `branch_hash` = :branch_hash AND `id` = :cursor LIMIT 1";
        $stmt = $this->modx->prepare($sql);
        if (!$stmt || !$stmt->execute([
            ':branch_hash' => $this->hashBranch($branch),
            ':cursor' => $cursor,
        ])) {
            return 0;
        }
        $valid = (int) $stmt->fetchColumn();
        $stmt->closeCursor();

        return $valid === $cursor ? $cursor : 0;
    }

    /**
     * Opportunistic bounded cleanup; safe to call at the start of a request.
     */
    public function cleanupExpired(int $limit = 500): int
    {
        $limit = max(1, min(5000, $limit));
        $sql = "DELETE FROM {$this->table} WHERE `expires_at` < :now LIMIT {$limit}";
        $stmt = $this->modx->prepare($sql);
        if (!$stmt || !$stmt->execute([':now' => time()])) {
            $this->logging->write(__METHOD__, 'Could not clean expired events', [], false, 'warning', 'queue');
            return 0;
        }

        return $stmt->rowCount();
    }

    private function hashBranch(string $branch): string
    {
        return hash('sha256', $branch);
    }
}
