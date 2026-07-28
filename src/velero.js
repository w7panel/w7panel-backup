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
export const remove = (namespace, resource, name) => request(veleroPath(namespace, resource, name), { method: 'DELETE' })
export const namespaces = () => request('/api/v1/namespaces')

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
// Velero serializes metav1.Duration using Go's duration format (for example
// "720h0m0s"), not ISO-8601 ("PT720H"). The latter is accepted by the API
// server but causes Velero's Backup watch to fail decoding every Backup.
export function ttl(value) { return `${Math.max(1, Math.min(8760, Number(value) || DEFAULT_TTL_HOURS))}h0m0s` }

export function backupResource({ name, namespaces: selected, namespaceMode = 'include', resources: selectedResources, resourceMode = 'include', storageLocation, ttlHours }) {
  if (!validName(name)) throw new Error('备份名称必须为 63 字符以内的小写 DNS 名称')
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

export function restoreResource({ name, backupName, namespaces: selected, mapping = {} }) {
  if (!validName(name)) throw new Error('恢复名称必须为 63 字符以内的小写 DNS 名称')
  if (!backupName) throw new Error('请选择一个备份')
  const namespaceMapping = Object.fromEntries(Object.entries(mapping).filter(([from, to]) => from && to && from !== to))
  return {
    apiVersion: 'velero.io/v1', kind: 'Restore', metadata: { name },
    spec: {
      backupName, includedNamespaces: selected?.length ? selected : ['*'],
      includeClusterResources: false, existingResourcePolicy: 'none',
      ...(Object.keys(namespaceMapping).length ? { namespaceMapping } : {}),
    },
  }
}

export function scheduleResource({ name, cron, namespaces: selected, namespaceMode, resources, resourceMode, storageLocation, ttlHours, paused }) {
  if (!validName(name)) throw new Error('计划名称必须为 63 字符以内的小写 DNS 名称')
  if (!String(cron || '').trim()) throw new Error('请输入 Cron 表达式')
  return {
    apiVersion: 'velero.io/v1', kind: 'Schedule', metadata: { name },
    spec: { schedule: cron.trim(), paused: Boolean(paused), template: backupResource({ name: 'template', namespaces: selected, namespaceMode, resources, resourceMode, storageLocation, ttlHours }).spec },
  }
}

export function locationResource({ name, bucket, region, endpoint, forcePathStyle, credentialName, makeDefault }) {
  if (!validName(name) || !bucket || !region || !endpoint || !credentialName) throw new Error('请完整填写存储位置必填项')
  return {
    apiVersion: 'velero.io/v1', kind: 'BackupStorageLocation', metadata: { name },
    spec: { provider: 'aws', objectStorage: { bucket }, credential: { name: credentialName, key: 'cloud' }, default: Boolean(makeDefault), config: { region, s3Url: endpoint, s3ForcePathStyle: String(Boolean(forcePathStyle)) } },
  }
}

export function credentialsSecret(name, accessKey, secretKey) {
  if (!accessKey || !secretKey) throw new Error('请输入 Access Key 与 Secret Key')
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'w7panel-cluster-backup' } }, type: 'Opaque', stringData: { cloud: `[default]\naws_access_key_id=${accessKey}\naws_secret_access_key=${secretKey}\n` } }
}

export async function create(namespace, resource, body) {
  return request(veleroPath(namespace, resource), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function update(namespace, resource, name, body) {
  return request(veleroPath(namespace, resource, name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export async function patchSecret(namespace, name, body) {
  return request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify(body) })
}

export async function createSecret(namespace, body) {
  return request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
