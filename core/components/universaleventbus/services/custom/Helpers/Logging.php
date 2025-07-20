<?php
/**
 * Сервис для логирования работы скриптов
 */

namespace UniversalEventBus\Helpers;

/**
 * @author Arthur Shevchenko (https://t.me/ShevArtV)
 * @example
 *      $logging = new \UniversalEventBus\Helpers\Logging();
 *      $logFileName = self::class . 'txt';
 *      $logging->setPath($logFileName);
 *      $logging->write(__METHOD__, 'Test', ['class' => $className]);
 */
class Logging
{
    /**
     * @var string
     */
    public string $path;
    /**
     * @var bool|null
     */
    private bool $debug;

    /**
     * @param bool|null $debug
     */
    public function __construct(?bool $debug = true)
    {
        $this->debug = $debug;
        $this->initialize();
    }

    /**
     * @return void
     */
    private function initialize()
    {
        $this->setPath('log.txt');
    }

    public function setPath(?string $fileName = '', ?string $dir = '')
    {
        $dir = $dir ?: dirname(__FILE__, 3) . '/logs/' . date('d-m-Y') . '/';
        $this->path = $dir . $fileName;
        if (!file_exists($dir)) {
            mkdir($dir, 0777, true);
        }
    }

    /**
     * @param string $method
     * @param string $msg
     * @param array|null $data
     * @param bool|null $noDate
     * @return void
     */
    public function write(string $method, string $msg, ?array$data = [], ?bool $noDate = false)
    {
        if ($this->debug) {
            if (!$noDate) {
                $date = date('d.m.Y H:i:s');
                $text = "**$date** [$method] $msg" . PHP_EOL;
            } else {
                $text = PHP_EOL . "*************************** [$method] $msg ***************************" . PHP_EOL;
            }


            if (!empty($data)) {
                if(isset($data['callstack'])){
                    $data['callstack'] = $this->getCallStack();
                }
                file_put_contents($this->path, $text . print_r($data, 1) . PHP_EOL, FILE_APPEND);
            } else {
                file_put_contents($this->path, $text, FILE_APPEND);
            }
        }
    }

    /**
     * @return array
     */
    public function getCallStack(): array
    {
        $trace = debug_backtrace();
        $output = [];
        foreach ($trace as $frame) {
            $output[] = sprintf("%s:%d - %s", $frame['file'], $frame['line'], $frame['function']);
        }
        return $output;
    }
}
