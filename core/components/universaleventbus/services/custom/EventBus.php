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

    /**
     * @var \modX $modx
     */
    public \modX $modx;
    /**
     * @var Logging $logging
     */
    public Logging $logging;
    /**
     * @var QueueManager $queuemanager
     */
    public QueueManager $queuemanager;
    /**
     * @var \msoptionsprice|null $msop
     */
    protected ?\msoptionsprice $msop;
    /**
     * @var array|null $properties
     */
    private ?array $properties;
    /**
     * @var array $replacements
     */
    public array $replacements = [];
    /**
     * @var bool $isBot
     */
    private bool $isBot = false;
    /**
     * @var array $output
     */
    public array $output = [];
    /**
     * @var array|string[] $cacheOptions
     */
    private array $cacheOptions = [\xPDO::OPT_CACHE_KEY => 'eventbus'];
    /**
     * @var int $cacheExpireTime
     */
    private int $cacheExpireTime = 86400;
    /**
     * @var string $ctx
     */
    public string $ctx = 'web';
    /**
     * @var bool $debug
     */
    private bool $debug;
    /**
     * @var bool $useCache
     */
    private bool $useCache;
    /**
     * @var bool $dispatch
     */
    public bool $dispatch = true;
    /**
     * @var mixed $product
     */
    public array $product = [];
    /**
     * @var \miniShop2|null $miniShop2
     */
    public ?\miniShop2 $miniShop2 = null;
    /**
     * @var array $webConfig
     */
    public array $webConfig;
    /**
     * @var string $branch
     */
    public string $branch;
    /**
     * @var string $contextCookieName
     */
    private string $contextCookieName = 'ueb_context';
    /**
     * @var string $requestContextParam
     */
    private string $requestContextParam = 'ctx';

    /**
     * @var array $translit
     */
    private array $translit;
    /**
     * @var array $options
     */
    public array $options = [];

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
        $this->ctx = $_COOKIE[$this->contextCookieName] ?: $_REQUEST[$this->requestContextParam] ?: $this->modx->context->get('key');
        if ($this->ctx !== $this->modx->context->get('key')) {
            $this->modx->switchContext($this->ctx);
        }

        $this->branch = $this->properties['branch'] ?: session_id();
        $this->debug = $this->modx->getOption('ueb_debug', null, false);
        $this->useCache = $this->modx->getOption('ueb_cache', null, true);
        $translit = $this->modx->getOption('ueb_translit', null, '');
        $this->translit = $translit ? explode(',', $translit) : [];
        $this->logging = new Logging($this->debug);
        $this->queuemanager = new QueueManager($this->modx);
        $crawlerDetect = new CrawlerDetect;
        $this->isBot = $crawlerDetect->isCrawler();
        $this->msop = $this->setMsOptionPrice();
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
     * @return object|null
     */
    private function setMsOptionPrice(): ?object
    {
        $corePath = $this->modx->getOption(
            'msoptionsprice_core_path',
            null,
            $this->modx->getOption('core_path', null, MODX_CORE_PATH) . 'components/msoptionsprice/'
        );

        $msoptionsprice = $this->modx->getService(
            'msoptionsprice',
            'msoptionsprice',
            $corePath . 'model/msoptionsprice/',
            array('core_path' => $corePath)
        );
        if (!$msoptionsprice) {
            return null;
        }
        $msoptionsprice->initialize($this->ctx, []);
        return $msoptionsprice;
    }

    /**
     * @return void
     */
    public function setContextCookie()
    {
        $expirationTime = time() + (30 * 24 * 60 * 60);
        $q = $this->modx->newQuery('modContextSetting');
        $q->select('value');
        $q->where(['key' => 'http_host', 'context_key' => 'web']);
        if (!$host = $this->execute($this->getSQL($q), 'fetch', [\PDO::FETCH_COLUMN])[0]) {
            $host = $this->modx->getOption('http_host'); // получаем хост текущего контекста
        }
        if ($q->stmt->execute()) { // если в контексте web есть настройка http_host, то предполагается, что это базовый хост, а в других контекстах поддомены
            $host = $q->stmt->fetchColumn();
        }
        setcookie($this->contextCookieName, $this->modx->context->key, $expirationTime, '/', '.' . $host);
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
            'openClasses' => $openClasses ? explode(',', $openClasses) : [],
            'closeClasses' => $closeClasses ? explode(',', $closeClasses) : [],
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
     * @param string $eventName
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
            'userData' => [],
            'pageData' => $this->getPageData(),
            'orderData' => $this->getOrderData(),
            'cartData' => $this->getCartData(),
            'productsData' => [],
            'pushed' => []
        ];
        $this->output['userData'] = $this->getUserData($this->getUserId());
        $this->output['productsData'] = $this->getProductsData($eventName);
        if (empty($this->output['productsData']) && $this->output['pageData']['class_key'] === 'msProduct') {
            $this->output['productsData'] = [$this->getProductData($this->output['pageData'])];
        }

        $this->modx->invokeEvent('OnUebHandleEvent', [
            'options' => $this->options,
            'output' => $this->output,
            'EventBus' => &$this
        ]);

        if ($this->dispatch) {
            $this->queuemanager->addToQueue($this->branch, $this->output, $this->options);
        }
    }

    /**
     * @return int
     */
    private function getUserId(): int
    {
        if(!empty($this->output['orderData'])) {
            return $this->output['orderData']['user_id'];
        }

        if ($this->modx->user->isAuthenticated($this->ctx)) {
            return $this->modx->user->id;
        }
        return $_SESSION['user_id'] ?? 0;
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
    public function getUserData(int $userId): array
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

        if(!empty($this->output['orderData'])){
            $address = [];
            foreach ($this->output['orderData'] as $key => $value) {
                if(strpos($key, 'address_') === false){
                    continue;
                }
                $key = str_replace('address_', '', $key);
                $address[$key] = $value;
            }
            $userData = array_merge($userData, $address);
        }

        return $this->filterArray($userData);
    }

    /**
     * @return array
     */
    public function getPageData(): array
    {
        if (!$where = $this->getConditionsForGetResourceData()) {
            $this->dispatch = false;
            return [];
        }

        $resourceData = $this->getResourceData($where);
        $this->dispatch = isset($resourceData['id']);
        if ($this->msop && $resourceData['class_key'] === 'msProduct') {
            $resourceData['modification'] = (int)$_REQUEST['mid'];
            $resourceData['options'] = [];
            if ($_REQUEST['options']) {
                $resourceData['options'] = is_array($_REQUEST['options']) ? $_REQUEST['options'] : json_decode($_REQUEST['options'], true);
            }
            $resourceData['variant'] = $this->getProductVariant($resourceData);
        }
        return $this->filterArray($resourceData);
    }


    /**
     * @return array
     */
    private function getConditionsForGetResourceData(): array
    {
        $extension = pathinfo($_SERVER['REQUEST_URI'], PATHINFO_EXTENSION);
        $extension = explode('?', $extension)[0];
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
     * @param string|null $fetchMethod
     * @return array
     */

    public function getResourceData(array $where, ?string $fetchMethod = 'fetch'): array
    {
        $hash = md5(json_encode($where));
        if ($this->useCache && $output = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
            return $output;
        }

        $q = $this->modx->newQuery('modResource');
        $q->select($this->modx->getSelectColumns('modResource', 'modResource'));
        $q->leftJoin('modResource', 'Category', 'modResource.parent = Category.id');
        $q->select('Category.pagetitle as category');
        if ($this->miniShop2 instanceof \miniShop2) {
            $q->leftJoin('msProductData', 'Data', 'modResource.id = Data.id');
            $q->select($this->modx->getSelectColumns('msProductData', 'Data', '', ['id'], true));
            $q->leftJoin('msVendor', 'Vendor', 'Data.vendor = Vendor.id');
            $q->select($this->modx->getSelectColumns('msVendor', 'Vendor', 'vendor_'));
        }
        $q->where($where);
        if ($output = $this->execute($this->getSQL($q), $fetchMethod)) {
            if ($fetchMethod === 'fetchAll') {
                foreach ($output as $k => $v) {
                    $output[$k]['url'] = $this->modx->makeUrl($v['id'], $this->ctx, '', 'full');
                }
            } else {
                $output['url'] = $this->modx->makeUrl($output['id'], $this->ctx, '', 'full');
            }

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
    public function getOrderData(): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $orderId = $this->getOrderId();
        if (!$orderId) {
            return [];
        }

        $q = $this->modx->newQuery('msOrder');
        $q->leftJoin('msOrderAddress', 'Address');
        $q->leftJoin('msDelivery', 'Delivery', 'Delivery.id = msOrder.delivery');
        $q->leftJoin('msPayment', 'Payment', 'Payment.id = msOrder.payment');
        $q->select($this->modx->getSelectColumns('msOrder', 'msOrder'));
        $q->select($this->modx->getSelectColumns('msOrderAddress', 'Address', 'address_'));
        $q->select($this->modx->getSelectColumns('msDelivery', 'Delivery', 'delivery_'));
        $q->select($this->modx->getSelectColumns('msPayment', 'Payment', 'payment_'));
        $q->where(['msOrder.id' => $orderId]);
        $orderData = $this->execute($this->getSQL($q));
        if ($this->debug) {
            $this->logging->write(__METHOD__ . ':' . __LINE__, 'orderData: ', $orderData);
        }
        foreach ($orderData as $k => $v) {
            if(strpos($k, 'properties') !== false && !is_array($v)) {
                $orderData[$k] = json_decode($v, true);
            }
        }

        $orderData = $this->translitArray($orderData);
        return $this->filterArray($orderData);
    }

    /**
     * @return array
     */
    public function getCartData(): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $cart = $this->miniShop2->cart->get();
        $item = $cart[$this->properties['key']] ?? $_SESSION['ueb']['cart'][$this->properties['key']] ?? [];
        $oldCount = $_SESSION['ueb']['cart'][$this->properties['key']]['count'] ?? 0;
        if ($oldCount - $item['count'] > 0) {
            $item['count_change'] = 'remove';
        }
        $item['count_diff'] = abs($item['count'] - $oldCount);
        if ($oldCount - $item['count'] < 0) {
            $item['count_change'] = 'add';
        }
        if ($oldCount === $item['count']) {
            $item['count_change'] = '';
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
        $orderId = $_REQUEST['msorder'] ?: $_SESSION['ueb']['msorder'] ?: $_SESSION['ueb']['orderId'] ?? 0;
        $msOrder = $this->properties['msOrder'] ?: $this->properties['order'];

        if ($msOrder instanceof \msOrder) {
            $orderId = $msOrder->get('id');
        }
        if ($msOrder instanceof \msOrderHandler) {
            $orderData = $msOrder->get();
            $orderId = $orderData['id'];
        }
        return $orderId;
    }

    /**
     * @param $eventName
     * @return array
     */
    public function getProductsData($eventName): array
    {
        if (!($this->miniShop2 instanceof \miniShop2)) {
            return [];
        }
        $output = [];

        if ($_REQUEST['ids']) {
            $ids = explode(',', $_REQUEST['ids']);

            foreach ($ids as $id) {
                $options = [];
                if ($_REQUEST['options']) {
                    $options = is_array($_REQUEST['options']) ? $_REQUEST['options'] : json_decode($_REQUEST['options'], true);
                }
                $output[] = $this->getProductData([
                    'product_id' => $id,
                    'options' => $options[$id] ?? [],
                    'mid' => $_REQUEST[$id]['mid'] ?: 0
                ]);
            }
            return $output;
        }

        $orderId = $this->getOrderId();
        if (!$orderId) {
            if (strpos($eventName, 'Cart') === false) {
                return [];
            }
            if($this->properties['key']){
                $output[] = $this->getProductData($this->output['cartData']['item']);
            }else{
                $cart = $this->miniShop2->cart->get();
                foreach ($cart as $product) {
                    $output[] = $this->getProductData($product);
                }
            }

        } else {
            $q = $this->modx->newQuery('msOrderProduct');
            $q->select($this->modx->getSelectColumns('msOrderProduct', 'msOrderProduct'));
            $q->where(['msOrderProduct.order_id' => $orderId]);
            $products = $this->execute($this->getSQL($q), 'fetchAll');
            foreach ($products as $product) {
                unset($product['id']);
                $product['options'] = json_decode($product['options'], true);
                $output[] = $this->getProductData($product);
            }
        }
        return $output;
    }

    /**
     * @param array $product
     * @return array
     */
    public function getProductData(array $product): array
    {
        $data = $this->getResourceData(['id' => ($product['product_id'] ?: $product['id'])]);
        $product = array_merge($data, $product);
        $product['cost'] = $product['price'] * $product['count'];

        if ($this->msop && empty($product['variant'])) {
            $product['variant'] = $this->getProductVariant($product);
        }

        $this->product = [
            'id' => $product['id'],
            'name' => $product['pagetitle'],
            'price' => $product['price'],
            'quantity' => $product['count'],
            'weight' => $product['weight'],
            'cost' => $product['cost'],
            'url' => $product['url'],
            'brand' => $product['vendor_name'],
            'category' => $product['category'],
            'options' => $product['options'],
            'variant' => $product['variant'],
            'position' => $product['menuindex'],
            'list' => $product['category'],
            'count_diff' => $product['count_diff'],
        ];

        $this->modx->invokeEvent('OnUebGetProductData', [
            'product' => $this->product,
            'EventBus' => &$this
        ]);

        $product = $this->translitArray($this->product);

        return $this->filterArray($product);
    }

    public function getProductVariant(array $product): array
    {
        $output = [];
        $modificationId = $product['options']['modification'] ?: $product['modification'];
        if ($modificationId) {
            $output = $this->getModificationById((int)$modificationId);
        } elseif (isset($product['options'])) {
            $output = $this->getModificationByOptions($product);
        }
        return $this->filterArray($output);
    }

    /**
     * @param int $id
     * @return array
     */
    public function getModificationById(int $id): array
    {
        $hash = md5('msopModification' . $id);
        if ($this->useCache && $output = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
            return $output;
        }
        $q = $this->modx->newQuery('msopModification');
        $q->select($this->modx->getSelectColumns('msopModification', 'msopModification'));
        $q->where(['id' => $id]);
        if ($output = $this->execute($this->getSQL($q))) {
            $this->modx->cacheManager->set($hash, $output, $this->cacheExpireTime, $this->cacheOptions);
            return $output;
        }

        return [];
    }

    /**
     * @param array $data
     * @return array
     */
    public function getModificationByOptions(array $data): array
    {
        if (!$this->msop) {
            return [];
        }
        $productId = $data['product_id'] ?: $data['id'];
        $hash = md5(strtolower($productId . serialize($data['options'])));
        if ($this->useCache && $output = $this->modx->cacheManager->get($hash, $this->cacheOptions)) {
            return $output;
        }
        $excludeIds = array(0);
        $excludeType = array(0, 2, 3);
        if (!is_array($data['options'])) {
            $data['options'] = json_decode($data['options'], true);
        }
        if (!$modification = $this->msop->getModificationByOptions($productId, $data['options'], null, $excludeIds, $excludeType)) {
            return [];
        }

        $this->modx->cacheManager->set($hash, $modification, $this->cacheExpireTime, $this->cacheOptions);
        return $modification;
    }

    /**
     * @param string|null $string
     * @return string
     */
    public function getTranslitString(?string $string): string
    {
        if (!$string) {
            return '';
        }

        $r = $this->modx->newObject('modResource');
        $string = $r->cleanAlias($string);
        unset($r);
        return $string;
    }

    /**
     * @param string $sql
     * @param string|null $method
     * @param array $fetchType
     * @return array|string
     */
    public function execute(string $sql, ?string $method = 'fetch', array $fetchType = [\PDO::FETCH_ASSOC])
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
    public function filterArray(array $array): array
    {
        if (empty($array)) {
            return [];
        }
        return array_diff($array, [null, false, '', 0]);
    }

    /**
     * @param array $array
     * @return array
     */
    public function translitArray(array $array):array {
        if(empty($this->translit) || empty($array)) {
            return $array;
        }

        foreach ($this->translit as $key) {
            $path = explode('.', $key);
            $target = &$array;

            foreach ($path as $segment) {
                $target = &$target[$segment];
            }

            $target = $this->getTranslitString($target);
            unset($target);
        }

        return $array;
    }

    /**
     * @return void
     */
    public function cleanCache(): void
    {
        $this->modx->cacheManager->clean($this->cacheOptions);
    }
}
