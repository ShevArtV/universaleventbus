<?php

namespace UniversalEventBus\Helpers;

/**
 * Принадлежность заказа текущему посетителю (miniShop2).
 *
 * Id заказа из запроса подделывается: без проверки любой POST с msorder=N отдавал в шину
 * адрес, контакты и состав чужого заказа. Правила — как у canView в msGetOrder, только
 * анонимный user_id = 0 своим не считается.
 */
class OrderAccess
{
    /** @var \modX */
    private \modX $modx;

    public function __construct(\modX $modx)
    {
        $this->modx = $modx;
    }

    public function isOwned(int $orderId): bool
    {
        if ($orderId <= 0) {
            return false;
        }
        $sessionOrders = array_map('intval', (array)($_SESSION['minishop2']['orders'] ?? []));
        if (in_array($orderId, $sessionOrders, true)) {
            return true;
        }
        if ($this->modx->user && $this->modx->user->hasSessionContext('mgr')) {
            return true;
        }
        $userId = $this->modx->user ? (int)$this->modx->user->get('id') : 0;
        if ($userId > 0 && $this->modx->getCount('msOrder', ['id' => $orderId, 'user_id' => $userId])) {
            return true;
        }

        $this->modx->log(\modX::LOG_LEVEL_WARN, sprintf(
            '[UniversalEventBus] foreign order rejected: id=%d, user=%d, ip=%s',
            $orderId,
            $userId,
            $_SERVER['REMOTE_ADDR'] ?? ''
        ));
        return false;
    }
}
