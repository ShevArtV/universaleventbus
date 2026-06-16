<?php
/**
 * @author Arthur Shevchenko (https://t.me/ShevArtV)
 * @description Логирование UniversalEventBus. Делегирует записи компоненту mxLogger,
 * если он установлен; если mxLogger не установлен — не логирует (штатное файловое
 * логирование заменено на mxLogger).
 * @example
 *      $logging = new \UniversalEventBus\Helpers\Logging($modx);
 *      $logging->write(__METHOD__, 'Test', ['class' => $className], false, 'debug', 'events');
 */

namespace UniversalEventBus\Helpers;

class Logging
{
    /** Базовые тэги: имя пакета + цепочка (события e-commerce). */
    private const TAG = 'universaleventbus';
    private const CHAIN_TAG = 'events';

    /** Уровни и их числовой вес — для сравнения с минимальным уровнем (как в mxLogger). */
    private const LEVELS = array(
        'debug'   => 10,
        'info'    => 20,
        'warning' => 30,
        'error'   => 40,
    );

    /** @var \modX */
    private $modx;

    /** @var bool Включено ли логирование (ueb_debug). */
    private $debug;

    /** @var string Минимальный уровень записи (ueb_log_level): записи ниже отбрасываются. */
    private $minLevel;

    /** @var string|null process_uid воронки. */
    private $processUid = null;

    /**
     * @var \mxLogger|null|false false — ещё не резолвили; null — не установлен;
     *      объект — доступный сервис mxLogger.
     */
    private $mxl = false;

    /**
     * @param \modX       $modx
     * @param bool|null   $debug    Гейт вкл/выкл (ueb_debug).
     * @param string|null $minLevel Минимальный уровень (ueb_log_level). Если null —
     *                              берётся из настройки ueb_log_level (по умолчанию debug).
     */
    public function __construct(\modX $modx, ?bool $debug = true, ?string $minLevel = null)
    {
        $this->modx = $modx;
        $this->debug = $debug === null ? true : (bool) $debug;
        $this->minLevel = $this->normalizeLevel(
            $minLevel === null ? $modx->getOption('ueb_log_level', null, 'debug') : $minLevel
        );
    }

    /** Привести уровень к одному из известных; неизвестный → debug (пишем всё). */
    private function normalizeLevel($level): string
    {
        $level = strtolower((string) $level);
        return isset(self::LEVELS[$level]) ? $level : 'debug';
    }

    /** Достаточен ли уровень записи для текущего минимального порога. */
    private function levelEnabled(string $level): bool
    {
        return self::LEVELS[$this->normalizeLevel($level)] >= self::LEVELS[$this->minLevel];
    }

    /**
     * Оставлено для обратной совместимости со старым API (раньше задавало путь
     * файла лога). Файлового лога больше нет — метод ничего не делает.
     */
    public function setPath(?string $fileName = '', ?string $dir = '')
    {
    }

    /**
     * Задать process_uid воронки. Пустое/null — сбросить.
     *
     * @param string|null $uid
     * @return void
     */
    public function setProcess($uid)
    {
        $this->processUid = ($uid !== null && $uid !== '') ? (string) $uid : null;
    }

    /**
     * Записать лог. Сигнатура сохранена для обратной совместимости (позиционные
     * $method, $msg, $data); добавлены $level и $tags для mxLogger.
     *
     * @param string     $method Метод-источник (попадёт в context.source).
     * @param string     $msg    Текст сообщения.
     * @param array|null $data   Контекст.
     * @param bool|null  $noDate Не используется (наследие файлового лога).
     * @param string     $level  debug|info|warning|error (по умолчанию info).
     * @param string|array $tags  Доп. тэг(и) к базовым «universaleventbus»/«events».
     * @return void
     */
    public function write(string $method, string $msg, ?array $data = [], ?bool $noDate = false, string $level = 'info', $tags = [])
    {
        if (!$this->debug) {
            return;
        }
        if (!$this->levelEnabled($level)) {
            return;
        }

        $mxl = $this->resolveMxLogger();
        if ($mxl === null) {
            return; // mxLogger не установлен — не логируем
        }

        $context = is_array($data) ? $data : array('data' => $data);
        if ($method !== '') {
            $context['source'] = $method;
        }

        // Базовые тэги (имя пакета + цепочка) + дополнительные (этап).
        $allTags = array(self::TAG, self::CHAIN_TAG);
        foreach ((array) $tags as $tag) {
            $tag = (string) $tag;
            if ($tag !== '' && !in_array($tag, $allTags, true)) {
                $allTags[] = $tag;
            }
        }

        $options = array('skip_classes' => array(self::class));
        if ($this->processUid !== null && $this->processUid !== '') {
            $options['process_uid'] = $this->processUid;
        }
        $mxl->log($allTags, $level, (string) $msg, $context, $options);
    }

    /**
     * Лениво получить сервис mxLogger (или null, если пакет не установлен).
     *
     * @return \mxLogger|null
     */
    private function resolveMxLogger()
    {
        if ($this->mxl !== false) {
            return $this->mxl;
        }
        if (isset($this->modx->mxlogger) && $this->modx->mxlogger instanceof \mxLogger) {
            return $this->mxl = $this->modx->mxlogger;
        }
        $corePath = $this->modx->getOption(
            'mxlogger.core_path',
            null,
            $this->modx->getOption('core_path') . 'components/mxlogger/'
        );
        if (is_file($corePath . 'model/mxlogger/mxlogger.class.php')) {
            $svc = $this->modx->getService('mxlogger', 'mxLogger', $corePath . 'model/mxlogger/');
            if ($svc instanceof \mxLogger) {
                return $this->mxl = $svc;
            }
        }

        $this->modx->log(
            \modX::LOG_LEVEL_ERROR,
            '[UniversalEventBus] Установите mxLogger или отключите логирование в настройках пакета (ключ настройки ueb_debug).'
        );

        return $this->mxl = null;
    }
}
