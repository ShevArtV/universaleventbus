<?php

namespace UniversalEventBus;


use UniversalEventBus\Helpers\Logging;
use UniversalEventBus\Helpers\QueueManager;
use Jaybizzle\CrawlerDetect\CrawlerDetect;

/**
 * @author Arthur Shevchenko (shev.art.v@yandex.ru)
 * @description Класс для передачи сервверных событий на фронт.
 */
class EventBus
{

    /** @var \modX $modx */
    public \modX $modx;
    /** @var Logging $logging */
    public Logging $logging;
    /** @var QueueManager $queuemanager */
    public QueueManager $queuemanager;
    /**
     * @var array|null
     */
    private ?array $properties;
    /**
     * @var array
     */
    public array $replacements = [];
    /**
     * @var bool
     */
    private bool $isBot = false;
    /**
     * @var array
     */
    public array $output = [];
    /**
     * @var array|string[]
     */
    private array $cacheOptions = [\xPDO::OPT_CACHE_KEY => 'eventbus'];
    /**
     * @var int
     */
    private int $cacheExpireTime = 86400;
    /**
     * @var string
     */
    public string $ctx = 'web';
    /**
     * @var bool
     */
    private bool $debug;
    /**
     * @var bool
     */
    private bool $useCache;
    /**
     * @var bool
     */
    public bool $dispatch = true;
    /**
     * @var mixed
     */
    public array $product = [];
    /**
     * @var \miniShop2|null
     */
    public ?\miniShop2 $miniShop2 = null;
    /**
     * @var array
     */
    public array $webConfig;
    /**
     * @var string
     */
    public string $branch;

    /**
     * @param \modX $modx
     * @param array|null $properties
     */
    public function __construct(\modX $modx, ?array $properties = [])
    {
        $this->modx = $modx;
        $this->properties = $properties;
        $this->initialize();
    }

    /**
     * @return void
     */
    private function initialize()
    {
        $this->branch = $this->properties['branch'] ?: session_id();
        $this->debug = $this->modx->getOption('ueb_debug', null, false);
        $this->useCache = $this->modx->getOption('ueb_cache', null, true);
        $this->logging = new Logging($this->debug);
        $this->queuemanager = new QueueManager($this->modx);
        $crawlerDetect = new CrawlerDetect;
        $this->isBot = $crawlerDetect->isCrawler();
        $this->ctx = $this->modx->context->get('key');
        $this->miniShop2 = $this->modx->getService('miniShop2');
        if ($this->miniShop2 && !$this->miniShop2->initialized[$this->ctx]) {
            $this->miniShop2->initialize($this->ctx);
        }

        $this->modx->invokeEvent('OnUebInit', [
            'branch' => $this->branch,
            'EventBus' => &$this
        ]);
    }

    /**
     * @param int $templateId
     * @return void
     */
    public function loadJS(int $templateId)
    {
        $allowedTemplates = $this->modx->getOption('ueb_allowed_templates', null, '');
        $allowedTemplates = $allowedTemplates ? explode(',', $allowedTemplates) : [];
        if (!empty($allowedTemplates) && !in_array($templateId, $allowedTemplates)) {
            return;
        }

        $indexJS = $this->modx->getOption('ueb_frontend_js', '', '');
        $packageVersion = $this->getPackageVersion();
        $scriptsVersion = $packageVersion ? '?v=' . md5($packageVersion) : '';
        $openClasses = $this->modx->getOption('ueb_open_classes', '', '');
        $closeClasses = $this->modx->getOption('ueb_close_classes', '', '');
        //$scriptsVersion = '?v=' . time();

        $this->webConfig = [
            'version' => $scriptsVersion,
            'handlerPath' => $this->modx->getOption('ueb_sse_handler_path', '', '/assets/components/universaleventbus/php/ssehandler.php'),
            'actionUrl' => $this->modx->getOption('ueb_action_url', '', '/assets/components/universaleventbus/php/action.php'),
            'openClasses' => explode(',', $openClasses),
            'closeClasses' => explode(',', $closeClasses),
        ];

        $this->modx->invokeEvent('OnGetUebWebConfig', [
            'webConfig' => $this->webConfig,
            'object' => $this
        ]);

        $webConfig = json_encode($this->webConfig, JSON_UNESCAPED_UNICODE);
        if ($indexJS) {
            $indexJS .= $scriptsVersion;
            $this->modx->regClientScript(
                "<script> window.uebConfig = {$webConfig}; </script>",
                1
            );
            $this->modx->regClientScript('<script type="module" src="' . $indexJS . '"></script>', 1);
        }
    }

    /**
     * @return string
     */
    private function getPackageVersion(): string
    {
        $q = $this->modx->newQuery('transport.modTransportPackage');
        $q->select('signature');
        $q->sortby('installed', 'DESC');
        $q->limit(1);
        $q->prepare();
        if (!$q->stmt->execute()) {
            return '';
        }
        return $q->stmt->fetchColumn();
    }

    /**
     * @param $eventName
     * @return void
     */
    public function handleEvent(string $eventName)
    {
        $this->modx->invokeEvent('OnBeforeUebHandleEvent', [
            'dispatch' => $this->dispatch,
            'EventBus' => &$this
        ]);

        if ($this->isBot || !$this->dispatch) {
            return;
        }

        $this->output = [
            'eventName' => $eventName,
            'eventTime' => time(),
            'eventId' => $this->getEventId($eventName),
            'userData' => $this->getUserData($this->getUserId()),
            'pageData' => $this->getPageData(),
            'orderData' => $this->getOrderData(),
            'cartData' => $this->getCartData(),
            'productsData' => $this->getProductsData(),
            'pushed' => []
        ];

        $this->modx->invokeEvent('OnUebHandleEvent', [
            'output' => $this->output,
            'EventBus' => &$this
        ]);

        if ($this->dispatch) {
            $this->queuemanager->addToQueue($this->branch, $this->output);
        }
    }

    /**
     * @return int
     */
    private function getUserId(): int
    {
        $msOrder = $this->properties['msOrder'] ?: $this->properties['order'];
        if ($msOrder instanceof \msOrder) {
            return $msOrder->get('user_id');
        }
        if ($msOrder instanceof \msOrderHandler) {
            $orderData = $msOrder->get();
            return $orderData['user_id'];
        }
        if ($this->modx->user->isAuthenticated($this->ctx)) {
            return $this->modx->user->id;
        }
        return 0;
    }

    /**
     * @param string $eventName
     * @return string
     */
    public function getEventId(string $eventName): string
    {
        return md5($eventName . time());
    }

    /**
     * @param int $userId
     * @return array
     */
    private function getUserData(int $userId): array
    {
        $userData = [
            'ip' => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'],
            'userAgent' => $_SERVER['HTTP_USER_AGENT'],
            'referrer' => $_SERVER['HTTP_REFERER'],
            'id' => session_id(),
        ];

        $hash = md5($userId);
        if ($userId) {
            if ($this->useCache && $cached = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
                $userData = array_merge($userData, $cached);
                $this->modx->cacheManager->set($hash, $userData, $this->cacheExpireTime, $this->cacheOptions);
            } else {
                $q = $this->modx->newQuery('modUser');
                $q->leftJoin('modUserProfile', 'Profile');
                $q->select('modUser.username as username');
                $q->select($this->modx->getSelectColumns('modUserProfile', 'Profile'));
                $q->where([
                    'modUser.id' => $userId,
                ]);
                $userData = array_merge($userData, $this->execute($this->getSQL($q)));
            }
        }

        $msOrder = $this->properties['msOrder'] ?: $this->properties['order'];
        if ($msOrder instanceof \msOrder || $msOrder instanceof \msOrderHandler) {
            $address = $msOrder->getOne('Address');
            $userData = array_merge($userData, $address->toArray());
        }

        return $this->filterArray($userData);
    }

    /**
     * @return array
     */
    private function getPageData(): array
    {
        if (!$where = $this->getConditionsForGetResourceData()) {
            $this->dispatch = false;
            return [];
        }

        $resourceData = $this->getResourceData($where);
        $this->dispatch = isset($resourceData['id']);
        return $this->filterArray($resourceData);
    }


    /**
     * @return array
     */
    private function getConditionsForGetResourceData(): array
    {
        $extension = pathinfo($_SERVER['REQUEST_URI'], PATHINFO_EXTENSION);
        if (isset($this->properties['rid'])) {
            return [
                'id' => $this->properties['rid']
            ];
        } elseif (isset($this->properties['uri'])) {
            $uri = ltrim($this->properties['uri'], '/');
            return [
                'uri' => $uri,
                'context_key' => $this->ctx
            ];
        } elseif ($this->modx->resource && in_array($extension, ['html', ''])) {
            return [
                'id' => $this->modx->resource->id
            ];
        } elseif ($extension === 'php') {
            $uri = parse_url($_SERVER['HTTP_REFERER']);
            $uri = $uri['path'];
            $uri = ltrim($uri, '/');
            if (!$uri) {
                return [
                    'id' => $this->modx->getContext($this->ctx)->getOption('site_start')
                ];
            }
            return [
                'uri' => $uri,
                'context_key' => $this->ctx
            ];
        }

        return [];
    }

    /**
     * @param array $where
     * @return array
     */
    private function getResourceData(array $where): array
    {
        $hash = md5(json_encode($where));
        if ($this->useCache && $output = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
            return $output;
        }

        $q = $this->modx->newQuery('modResource');
        $q->select($this->modx->getSelectColumns('modResource', 'modResource'));
        $q->leftJoin('modResource', 'Category', 'modResource.parent = Category.id');
        $q->select('Category.pagetitle as parent_pagetitle');
        if ($this->miniShop2 instanceof \miniShop2) {
            $q->leftJoin('msProductData', 'Data', 'modResource.id = Data.id');
            $q->select($this->modx->getSelectColumns('msProductData', 'Data', '', ['id'], true));
            $q->leftJoin('msVendor', 'Vendor', 'Data.vendor = Vendor.id');
            $q->select($this->modx->getSelectColumns('msVendor', 'Vendor', 'vendor_'));
        }
        $q->where($where);

        if ($output = $this->execute($this->getSQL($q))) {
            $output['url'] = $this->modx->makeUrl($output['id'], $this->ctx, '', 'full');
            $this->modx->cacheManager->set($hash, $output, $this->cacheExpireTime, $this->cacheOptions);
            if ($this->debug) {
                $this->logging->write(__METHOD__ . ':' . __LINE__, 'resourceData: ', $output);
            }
            return $output;
        }
        return [];
    }

    /**
     * @return array
     */
    private function getOrderData(): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $orderId = $this->getOrderId();
        if (!$orderId) {
            return [];
        }
        $hash = md5($orderId);
        if ($this->useCache && $output = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
            return $output;
        }
        $q = $this->modx->newQuery('msOrder');
        $q->leftJoin('msOrderAddress', 'Address');
        $q->select($this->modx->getSelectColumns('msOrder', 'msOrder'));
        $q->select($this->modx->getSelectColumns('msOrderAddress', 'Address', 'address_'));
        $q->where(['msOrder.id' => $orderId]);
        $orderData = $this->execute($this->getSQL($q));
        $this->modx->cacheManager->set($hash, $orderData, $this->cacheExpireTime, $this->cacheOptions);
        if ($this->debug) {
            $this->logging->write(__METHOD__ . ':' . __LINE__, 'orderData: ', $orderData);
        }
        return $this->filterArray($orderData);
    }

    /**
     * @return array
     */
    private function getCartData(): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $cart = $this->miniShop2->cart->get();
        $item = $cart[$this->properties['key']] ?? [];
        $oldCount = $_SESSION['ueb']['cart'][$this->properties['key']]['count'] ?? 0;
        if ($oldCount - $item['count'] > 0) {
            $item['count_change'] = 'decrease';
        }
        if ($oldCount - $item['count'] < 0) {
            $item['count_change'] = 'increase';
        }
        if ($oldCount === $item['count']) {
            $item['count_change'] = 'none';
        }
        $_SESSION['ueb']['cart'] = $cart;
        return [
            'products' => $cart,
            'status' => $this->miniShop2->cart->status(),
            'item' => $item
        ];
    }

    /**
     * @return int
     */
    private function getOrderId(): int
    {
        $orderId = $_SESSION['ueb']['orderId'] ?? 0;
        $msOrder = $this->properties['msOrder'] ?: $this->properties['order'];
        if ($msOrder instanceof \msOrder || $msOrder instanceof \msOrderHandler) {
            $orderId = $msOrder->get('id');
        }
        return $orderId;
    }

    /**
     * @return array
     */
    private function getProductsData(): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $orderId = $this->getOrderId();
        $output = [];
        if (!$orderId) {
            $cart = $this->miniShop2->cart->get();
            foreach ($cart as $product) {
                $output[] = $this->getProductData($product);
            }
        } else {
            $q = $this->modx->newQuery('msOrderProduct');
            $q->select($this->modx->getSelectColumns('msOrderProduct', 'msOrderProduct'));
            $q->where(['msOrderProduct.order_id' => $orderId]);
            $result = $this->execute($this->getSQL($q));
            if (isset($result['id'])) {
                $products[] = $result;
            } else {
                $products = $result;
            }

            foreach ($products as $product) {
                unset($product['id']);
                $output[] = $this->getProductData($product);
            }
        }
        return $output;
    }

    /**
     * @param array $product
     * @return array
     */
    private function getProductData(array $product): array
    {
        $data = $this->getResourceData(['id' => ($product['product_id'] ?: $product['id'])]);
        $product = array_merge($data, $product);
        $product['cost'] = $product['price'] * $product['count'];

        $this->product = [
            'id' => $product['id'],
            'name' => $product['pagetitle'],
            'price' => $product['price'],
            'count' => $product['count'],
            'weight' => $product['weight'],
            'cost' => $product['cost'],
            'url' => $product['url'],
            'vendor' => $product['vendor_name'],
            'options' => $product['options'],
        ];

        $this->modx->invokeEvent('OnUebGetProductsData', [
            'product' => $this->product,
            'EventBus' => &$this
        ]);

        return $this->product;
    }

    /**
     * @param string $sql
     * @param string|null $method
     * @param array $fetchType
     * @return array
     */
    public function execute(string $sql, ?string $method = 'fetch', array $fetchType = [\PDO::FETCH_ASSOC]): array
    {
        $tstart = microtime(true);
        $sql = preg_replace('/^SELECT/', 'SELECT SQL_CALC_FOUND_ROWS', $sql);
        $stmt = $this->modx->prepare($sql);
        if ($stmt->execute()) {
            $this->modx->queryTime += microtime(true) - $tstart;
            $this->modx->executedQueries++;
            return $stmt->$method(implode('|', $fetchType)) ?: [];
        }
        return [];
    }

    /**
     * @param \xPDOQuery $q
     * @return string
     */
    public function getSQL(\xPDOQuery $q): string
    {
        $q->prepare();
        $sql = $q->toSQL();
        $sql = str_replace('``,', '', $sql);

        if (!empty($this->replacements)) {
            foreach ($this->replacements as $k => $v) {
                $sql = str_replace($k, $v, $sql);
            }
            $this->replacements = [];
        }
        if ($this->debug) {
            $this->logging->write(__METHOD__ . ':' . __LINE__, 'SQL: ', $sql);
        }
        return $sql;
    }

    /**
     * @param array $array
     * @return array
     */
    private function filterArray(array $array): array
    {
        return array_diff($array, [null, false, '', 0]);
    }

    /**
     * @return void
     */
    public function cleanCache(): void
    {
        $this->modx->cacheManager->clean($this->cacheOptions);
    }
}
