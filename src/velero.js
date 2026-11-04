const API = '/apis/velero.io/v1'
const DEFAULT_TTL_HOURS = 720

export function props() {
  return globalThis.window?.__POWERED_BY_WUJIE__ ? globalThis.window?.$wujie?.props : globalThis.microData?.cd
}

export function isMicroappRuntime() {
  return Boolean(globalThis.window?.__POWERED_BY_WUJIE__ || globalThis.microData?.cd)
}

export function localProxyPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('本地 Kubernetes 请求路径无效')
  return `/k8s-proxy${path}`
}

export function veleroPath(namespace, resource, name = '') {
  return `${API}/namespaces/${encodeURIComponent(namespace)}/${resource}${name ? `/${encodeURIComponent(name)}` : ''}`
}

export function veleroDeploymentPath(namespace) {
  return `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/velero`
}

async function failure(response) {
  const text = await response.text()
  let message = text
  try { message = JSON.parse(text).message || JSON.parse(text).error || text } catch { /* response is not JSON */ }
  const error = new Error(message || `Kubernetes 请求失败 (${response.status})`)
  error.status = response.status
  throw error
}

export async function request(path, options = {}) {
  const proxy = props()?.k8sproxy
  if (typeof proxy !== 'function' && isMicroappRuntime()) throw new Error('微应用未注入 k8sproxy，无法访问集群备份资源')
  const response = typeof proxy === 'function'
    ? await proxy(path, options)
    : await fetch(localProxyPath(path), { ...options, credentials: 'same-origin' })
  if (!response.ok) await failure(response)
  if (response.status === 204) return null
  return response.json()
}

export const list = (namespace, resource) => request(veleroPath(namespace, resource))
export const get = (namespace, resource, name) => request(veleroPath(namespace, resource, name))
export const veleroDeployment = (namespace) => request(veleroDeploymentPath(namespace))
export const remove = (namespace, resource, name) => request(veleroPath(namespace, resource, name), { method: 'DELETE' })
export const namespaces = () => request('/api/v1/namespaces')
export const secretPath = (namespace, name) => `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets${name ? `/${encodeURIComponent(name)}` : ''}`

function discoveredResources(document, group = '') {
  return (document.resources || [])
    .filter((resource) => resource.name && !resource.name.includes('/') && resource.verbs?.includes('list'))
    .map((resource) => ({
      value: group ? `${resource.name}.${group}` : resource.name,
      label: group ? `${resource.kind || resource.name} · ${group} (${resource.name})` : `${resource.kind || resource.name} (${resource.name})`,
    }))
}

export async function discoverResources() {
  const [core, groups] = await Promise.all([request('/api'), request('/apis')])
  const paths = [
    ...(core.versions || []).map((version) => ({ path: `/api/${version}`, group: '' })),
    ...(groups.groups || []).map((group) => ({ path: `/apis/${group.preferredVersion?.groupVersion || group.versions?.[0]?.groupVersion}`, group: group.name })),
  ]
  const responses = await Promise.allSettled(paths.map(async ({ path, group }) => discoveredResources(await request(path), group)))
  const values = responses.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  return [...new Map(values.map((item) => [item.value, item])).values()].sort((left, right) => left.label.localeCompare(right.label))
}

export function validName(value) { return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(String(value || '')) && String(value).length <= 63 }

export const LOCATION_LABEL = 'backup.w7panel.io/ui-managed'
export const locationSecretName = name => `bsl-${name}`
export const managedLocation = location => location?.metadata?.labels?.[LOCATION_LABEL] === 'true' && !location.spec?.default && location.spec?.credential?.name === locationSecretName(location.metadata.name)
export const writableLocation = location => location?.status?.phase === 'Available' && location.spec?.accessMode !== 'ReadOnly'
export function locationReferences(name, backups, schedules) {
  return [...backups.filter(item => item.spec?.storageLocation === name).map(item => `备份 ${item.metadata.name}`), ...schedules.filter(item => item.spec?.template?.storageLocation === name).map(item => `计划 ${item.metadata.name}`)]
}
export function locationResource(form, original) {
  const { name, bucket, prefix, endpoint, region, forcePathStyle, accessMode } = form
  if (!validName(name) || name.length > 59) throw new Error('存储位置名称必须为 59 字符以内的小写 DNS 名称')
  if (!String(bucket || '').trim() || !String(region || '').trim()) throw new Error('请填写 Bucket 和 Region')
  let url
  try { url = new URL(String(endpoint || '')) } catch { throw new Error('请输入有效的 S3/COS Endpoint') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Endpoint 必须为不含路径和凭据的 HTTP(S) 地址')
  if (prefix && (prefix.startsWith('/') || prefix.endsWith('/') || prefix.split('/').includes('..'))) throw new Error('Prefix 不能以斜杠开头或结尾，也不能包含 .. 路径')
  if (!['ReadWrite', 'ReadOnly'].includes(accessMode)) throw new Error('请选择存储位置模式')
  return {
    apiVersion: 'velero.io/v1', kind: 'BackupStorageLocation',
    metadata: { name, labels: { ...(original?.metadata?.labels || {}), [LOCATION_LABEL]: 'true' } },
    spec: { provider: 'aws', default: false, accessMode, objectStorage: { bucket: bucket.trim(), ...(prefix ? { prefix } : {}) }, credential: { name: locationSecretName(name), key: 'cloud' }, config: { region: region.trim(), s3ForcePathStyle: String(Boolean(forcePathStyle)), s3Url: endpoint.trim() } },
  }
}
export function locationCredential(name, accessKey, secretKey) {
  if (!validName(name) || name.length > 59 || !accessKey || !secretKey || /[\r\n]/.test(accessKey + secretKey)) throw new Error('请填写不含换行的 Access Key 和 Secret Key')
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: locationSecretName(name), labels: { [LOCATION_LABEL]: 'true' } }, type: 'Opaque', stringData: { cloud: `[default]\naws_access_key_id=${accessKey}\naws_secret_access_key=${secretKey}` } }
}
// Velero serializes metav1.Duration using Go's duration format (for example
// "720h0m0s"), not ISO-8601 ("PT720H"). The latter is accepted by the API
// server but causes Velero's Backup watch to fail decoding every Backup.
export function ttl(value) { return `${Math.max(1, Math.min(8760, Number(value) || DEFAULT_TTL_HOURS))}h0m0s` }

function appSelector(id, excludedObjectIds) {
  return { matchLabels: { [`backup.w7panel.io/app-${id}`]: 'true' }, ...(excludedObjectIds.length ? { matchExpressions: [{ key: 'backup.w7panel.io/object-id', operator: 'NotIn', values: excludedObjectIds }] } : {}) }
}

export function backupResource({ name, namespaces: selected, namespaceMode = 'include', resources: selectedResources, resourceMode = 'include', storageLocation, ttlHours, objectIds, appId, appIds = [], excludedObjectIds = [] }) {
  if (!validName(name)) throw new Error('备份名称必须为 63 字符以内的小写 DNS 名称')
  if (objectIds && !objectIds.length) throw new Error('至少选择一个备份资源')
  const namespaceScope = namespaceMode === 'exclude'
    ? { includedNamespaces: ['*'], ...(selected?.length ? { excludedNamespaces: selected } : {}) }
    : { includedNamespaces: selected?.length ? selected : ['*'] }
  const resourceScope = resourceMode === 'exclude'
    ? selectedResources?.length ? { excludedResources: selectedResources } : {}
    : selectedResources?.length ? { includedResources: selectedResources } : {}
  return {
    apiVersion: 'velero.io/v1', kind: 'Backup', metadata: { name },
    spec: {
      ...namespaceScope, ...resourceScope, storageLocation,
      ...(objectIds ? { orLabelSelectors: objectIds.map(id => ({ matchLabels: { 'backup.w7panel.io/object-id': id } })), includeClusterResources: true } : {}),
      ...(appIds.length ? { orLabelSelectors: appIds.map(id => appSelector(id, excludedObjectIds)), includeClusterResources: true } : appId ? { labelSelector: appSelector(appId, excludedObjectIds), includeClusterResources: true } : {}),
      ttl: ttl(ttlHours), snapshotVolumes: false, defaultVolumesToFsBackup: false,
    },
  }
}

export function downloadRequestResource({ name, backupName }) {
  if (!validName(name) || !backupName) throw new Error('无法创建备份下载请求')
  return {
    apiVersion: 'velero.io/v1', kind: 'DownloadRequest', metadata: { name },
    spec: { target: { kind: 'BackupContents', name: backupName } },
  }
}

function privateIpv4(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
}

export function downloadEndpointIssue(endpoint) {
  try {
    const url = new URL(String(endpoint || ''))
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:') return '下载需要浏览器可访问的 HTTPS S3/COS Endpoint'
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.svc') || host.endsWith('.cluster.local') || privateIpv4(host) || host === '::1' || host.startsWith('fd')) return '当前对象存储地址为内网地址，无法在浏览器中下载'
    return ''
  } catch { return '请为存储位置配置有效的公网 HTTPS S3/COS Endpoint' }
}

export function restoreResource({ name, backupName, namespaces: selected, mapping = {}, objectIds, existingAppGroups = [], existingObjectKeys = [] }) {
  if (!validName(name)) throw new Error('恢复名称必须为 63 字符以内的小写 DNS 名称')
  if (!backupName) throw new Error('请选择一个备份')
  if (objectIds && !objectIds.length) throw new Error('至少选择一个恢复资源')
  const namespaceMapping = Object.fromEntries(Object.entries(mapping).filter(([from, to]) => from && to && from !== to))
  return {
    apiVersion: 'velero.io/v1', kind: 'Restore', metadata: { name, ...(objectIds ? { annotations: { 'backup.w7panel.io/hydrate-appgroups': 'true', 'backup.w7panel.io/existing-appgroups': JSON.stringify(existingAppGroups), 'backup.w7panel.io/existing-objects': JSON.stringify(existingObjectKeys) } } : {}) },
    spec: {
      backupName, includedNamespaces: selected?.length ? selected : ['*'],
      includeClusterResources: false, existingResourcePolicy: 'none',
      ...(objectIds ? { orLabelSelectors: objectIds.map(id => ({ matchLabels: { 'backup.w7panel.io/object-id': id } })), includeClusterResources: true } : {}),
      ...(Object.keys(namespaceMapping).length ? { namespaceMapping } : {}),
    },
  }
}

export function scheduleResource({ name, cron, namespaces: selected, namespaceMode, resources, resourceMode, storageLocation, ttlHours, paused, appId, appIds, excludedObjectIds }) {
  if (!validName(name)) throw new Error('计划名称必须为 63 字符以内的小写 DNS 名称')
  if (!String(cron || '').trim()) throw new Error('请输入 Cron 表达式')
  return {
    apiVersion: 'velero.io/v1', kind: 'Schedule', metadata: { name },
    spec: { schedule: cron.trim(), paused: Boolean(paused), template: backupResource({ name: 'template', namespaces: selected, namespaceMode, resources, resourceMode, storageLocation, ttlHours, appId, appIds, excludedObjectIds }).spec },
  }
}

export function restoreLocationIssue(location) {
  if (!location) return '未找到来源备份使用的存储位置'
  if (location.status?.phase !== 'Available') return `存储位置 ${location.metadata?.name || ''} 当前不可用，无法在此集群恢复`
  return ''
}

export async function create(namespace, resource, body) {
  return request(veleroPath(namespace, resource), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function update(namespace, resource, name, body) {
  return request(veleroPath(namespace, resource, name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
