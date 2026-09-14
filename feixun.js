;(function feixunCloudBootstrapRuntime(configuration = {}) {
  const host = globalThis;
  const promiseKey = '__FEIXUN_REMOTE_BOOTSTRAP_PROMISE_V1__';
  const readyKey = '__FEIXUN_REMOTE_RUNTIME_READY_V1__';
  const lastReleaseKey = 'feixun_last_verified_release_v1';
  const cacheName = 'feixun-verified-runtime-v1';
  const releaseTimeoutMs = Number(configuration.releaseTimeoutMs) || 12_000;
  const artifactTimeoutMs = Number(configuration.artifactTimeoutMs) || 180_000;
  const hedgeDelayMs = Number(configuration.hedgeDelayMs) || 6_000;
  const directHttp = host.location?.protocol === 'http:';
  const releaseUrls = [
    'https://gcore.jsdelivr.net/gh/pinyuanhuang6-ux/feixun-runtime@main/release.json',
    ...(directHttp ? ['http://www.asahizzz.top/feixun-runtime/runtime.php?file=release.json'] : []),
    'https://fastly.jsdelivr.net/gh/pinyuanhuang6-ux/feixun-runtime@main/release.json',
    'https://raw.githubusercontent.com/pinyuanhuang6-ux/feixun-runtime/main/release.json',
    'https://gist.githubusercontent.com/pinyuanhuang6-ux/88ffc1135b270ac044d85dbef3b5b8e6/raw/release.json',
  ];
  const artifactSources = [
    { base: 'https://gcore.jsdelivr.net/gh/pinyuanhuang6-ux/feixun-runtime@main/' },
    ...(directHttp ? [{ base: 'http://www.asahizzz.top/feixun-runtime/runtime.php?file=', query: true }] : []),
    { base: 'https://fastly.jsdelivr.net/gh/pinyuanhuang6-ux/feixun-runtime@main/' },
    { base: 'https://raw.githubusercontent.com/pinyuanhuang6-ux/feixun-runtime/main/' },
    { base: 'https://gist.githubusercontent.com/pinyuanhuang6-ux/88ffc1135b270ac044d85dbef3b5b8e6/raw/' },
  ];
  const hashPattern = /^[A-F0-9]{64}$/u;
  const pathPattern = /^feixun-(?:core|life)-[A-F0-9]{64}\.js$/u;

  if (host[promiseKey]) return host[promiseKey];

  function status(phase, detail = {}) {
    try {
      const EventCtor = host.CustomEvent || CustomEvent;
      host.dispatchEvent?.(new EventCtor('feixun:cloud-load-status:v1', {
        detail: { schema: 'feixun-cloud-load-status/v1', phase, ...detail },
      }));
    } catch { /* status reporting never blocks loading */ }
  }

  function failure(code, message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    return error;
  }

  function storage() {
    try { return host.parent?.localStorage || host.localStorage; } catch { return null; }
  }

  function readLastRelease() {
    try {
      const value = JSON.parse(storage()?.getItem(lastReleaseKey) || 'null');
      return validateRelease(value) ? value : null;
    } catch { return null; }
  }

  function saveLastRelease(release) {
    try { storage()?.setItem(lastReleaseKey, JSON.stringify(release)); } catch { /* cache metadata is optional */ }
  }

  function validateRelease(value) {
    if (!value || value.schema !== 'feixun-runtime-distribution/v1' || !/^\d{4}-\d{2}-\d{2}T/u.test(String(value.publishedAt || ''))) return false;
    const runtime = value.feixunRuntime;
    if (!runtime || runtime.schema !== 'feixun-runtime-artifacts/v1' || !Array.isArray(runtime.files) || runtime.files.length !== 2) return false;
    const roles = runtime.files.map(item => item?.role);
    if (roles[0] !== 'feixun' || roles[1] !== 'life') return false;
    return runtime.files.every(item => pathPattern.test(String(item.path || '')) && hashPattern.test(String(item.sha256 || '')) && Number.isSafeInteger(item.bytes) && item.bytes > 1_000);
  }

  async function sha256(bytes) {
    if (!host.crypto?.subtle) throw failure('WEB_CRYPTO_UNAVAILABLE', '当前页面无法使用 Web Crypto 校验飞讯文件');
    const digest = await host.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  async function fetchBytes(url, timeoutMs, controller) {
    let timer = 0;
    try {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw failure('HTTP_ERROR', `HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (controller.signal.aborted) throw failure('DOWNLOAD_TIMEOUT', `下载超过 ${Math.round(timeoutMs / 1_000)} 秒`, error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function discoverRelease() {
    status('checking_release');
    const attempts = await Promise.allSettled(releaseUrls.map(async url => {
      const controller = new AbortController();
      const bytes = await fetchBytes(url, releaseTimeoutMs, controller);
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!validateRelease(value)) throw failure('INVALID_RELEASE', '版本指针缺少不可变核心信息');
      return { value, url };
    }));
    const valid = attempts.filter(item => item.status === 'fulfilled').map(item => item.value);
    valid.sort((left, right) => Date.parse(right.value.publishedAt) - Date.parse(left.value.publishedAt));
    if (valid.length) return valid[0];
    const reasons = attempts.map((item, index) => `${new URL(releaseUrls[index]).host}: ${item.reason?.code || item.reason?.message || 'failed'}`);
    throw failure('RELEASE_UNAVAILABLE', `版本信息不可用：${reasons.join('；')}`);
  }

  async function openRuntimeCache() {
    try { return await host.caches?.open(cacheName); } catch { return null; }
  }

  function cacheKey(item) {
    return `https://feixun-runtime.invalid/${item.sha256}/${item.path}`;
  }

  async function readCachedArtifact(cache, item) {
    if (!cache) return null;
    try {
      const response = await cache.match(cacheKey(item));
      if (!response) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== item.bytes || await sha256(bytes) !== item.sha256) {
        await cache.delete(cacheKey(item));
        return null;
      }
      return bytes;
    } catch { return null; }
  }

  async function saveCachedArtifact(cache, item, bytes) {
    if (!cache) return;
    try {
      await cache.put(cacheKey(item), new Response(bytes, {
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'x-feixun-sha256': item.sha256 },
      }));
    } catch { /* runtime cache is optional */ }
  }

  function artifactUrl(source, path) {
    return source.query ? `${source.base}${encodeURIComponent(path)}` : `${source.base}${path}`;
  }

  async function downloadVerifiedArtifact(item, cache) {
    const cached = await readCachedArtifact(cache, item);
    if (cached) {
      status('artifact_cache_hit', { role: item.role, bytes: item.bytes });
      return cached;
    }

    status('artifact_downloading', { role: item.role, bytes: item.bytes });
    const controllers = artifactSources.map(() => new AbortController());
    const attempts = artifactSources.map((source, index) => (async () => {
      if (index) await new Promise(resolve => setTimeout(resolve, index * hedgeDelayMs));
      if (controllers[index].signal.aborted) throw failure('HEDGE_CANCELLED', '其他镜像已完成');
      const bytes = await fetchBytes(artifactUrl(source, item.path), artifactTimeoutMs, controllers[index]);
      if (bytes.byteLength !== item.bytes) throw failure('SIZE_MISMATCH', `文件大小不符：${bytes.byteLength}/${item.bytes}`);
      const actualHash = await sha256(bytes);
      if (actualHash !== item.sha256) throw failure('HASH_MISMATCH', `SHA-256 不一致：${actualHash.slice(0, 12)}`);
      return { bytes, source };
    })());

    try {
      const winner = await Promise.any(attempts);
      for (const controller of controllers) controller.abort();
      await saveCachedArtifact(cache, item, winner.bytes);
      status('artifact_verified', { role: item.role, source: new URL(artifactUrl(winner.source, item.path)).host, bytes: item.bytes });
      return winner.bytes;
    } catch (error) {
      for (const controller of controllers) controller.abort();
      const reasons = error?.errors?.map(reason => reason?.code || reason?.message || String(reason)) || [error?.code || error?.message || String(error)];
      throw failure('ARTIFACT_UNAVAILABLE', `${item.role} 核心所有镜像均失败：${reasons.join('、')}`, error);
    }
  }

  function executeArtifact(bytes, role) {
    const script = document.createElement('script');
    script.dataset.feixunRuntimeRole = role;
    script.textContent = new TextDecoder().decode(bytes);
    (document.head || document.documentElement).appendChild(script);
  }

  async function loadRelease(release, source) {
    const current = host[readyKey];
    const runtime = release.feixunRuntime;
    if (current?.publishedAt === release.publishedAt && current?.files?.every((file, index) => file.sha256 === runtime.files[index].sha256)) return current;
    const cache = await openRuntimeCache();
    const [feixunBytes, lifeBytes] = await Promise.all(runtime.files.map(item => downloadVerifiedArtifact(item, cache)));
    executeArtifact(feixunBytes, 'feixun');
    executeArtifact(lifeBytes, 'life');
    const ready = {
      schema: 'feixun-remote-runtime-ready/v1',
      publishedAt: release.publishedAt,
      source,
      files: runtime.files.map(({ role, path, sha256, bytes }) => ({ role, path, sha256, bytes })),
    };
    host[readyKey] = ready;
    saveLastRelease(release);
    status('ready', ready);
    try {
      const EventCtor = host.CustomEvent || CustomEvent;
      host.dispatchEvent?.(new EventCtor('feixun:cloud-ready:v1', { detail: ready }));
    } catch { /* ready marker is authoritative */ }
    console.log('[飞讯] 云端核心已校验并加载', release.publishedAt, source);
    return ready;
  }

  const task = (async () => {
    let remote = null;
    let remoteError = null;
    try { remote = await discoverRelease(); } catch (error) { remoteError = error; }
    const cachedRelease = readLastRelease();
    const candidates = [];
    if (remote) candidates.push({ release: remote.value, source: new URL(remote.url).host });
    if (cachedRelease && !candidates.some(item => item.release.publishedAt === cachedRelease.publishedAt)) {
      candidates.push({ release: cachedRelease, source: 'verified browser cache' });
    }
    if (!candidates.length) throw remoteError || failure('NO_RELEASE', '没有可用的飞讯版本信息或本地缓存');

    const errors = [];
    for (const candidate of candidates) {
      try { return await loadRelease(candidate.release, candidate.source); } catch (error) { errors.push(error); }
    }
    throw failure('RUNTIME_UNAVAILABLE', errors.map(error => `${error.code || 'ERROR'}: ${error.message}`).join('；'));
  })();

  const guarded = task.catch(error => {
    const code = error?.code || 'UNKNOWN';
    status('failed', { code, message: error?.message || String(error) });
    console.error('[飞讯] 云端加载失败', { code, message: error?.message || String(error), error });
    const text = code === 'RELEASE_UNAVAILABLE' || code === 'NO_RELEASE'
      ? '飞讯版本信息获取失败，请检查网络后重试。'
      : `飞讯核心加载失败（${code}），请稍后重试。`;
    host.toastr?.error?.(text);
    setTimeout(() => { if (host[promiseKey] === guarded) delete host[promiseKey]; }, 1_000);
    return { schema: 'feixun-remote-runtime-failed/v1', code, message: error?.message || String(error) };
  });
  host[promiseKey] = guarded;
  return guarded;
})({});
