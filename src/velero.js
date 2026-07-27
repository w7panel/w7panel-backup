const API = '/apis/velero.io/v1'
const DEFAULT_TTL_HOURS = 720

export function props() {
  return globalThis.window?.__POWERED_BY_WUJIE__ ? globalThis.window?.$wujie?.props : globalThis.microData?.cd
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
  if (typeof proxy !== 'function') throw new Error('微应用未注入 k8sproxy，无法访问集群备份资源')
  const response = await proxy(path, options)
  if (!response.ok) await failure(response)
  if (response.status === 204) return null
  return response.json()
}

export const list = (namespace, resource) => request(veleroPath(namespace, resource))
export const remove = (namespace, resource, name) => request(veleroPath(namespace, resource, name), { method: 'DELETE' })
export const namespaces = () => request('/api/v1/namespaces')

export function validName(value) { return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(String(value || '')) && String(value).length <= 63 }
export function ttl(value) { return `PT${Math.max(1, Math.min(8760, Number(value) || DEFAULT_TTL_HOURS))}H` }

export function backupResource({ name, namespaces: selected, storageLocation, ttlHours }) {
  if (!validName(name)) throw new Error('备份名称必须为 63 字符以内的小写 DNS 名称')
  return {
    apiVersion: 'velero.io/v1', kind: 'Backup', metadata: { name },
    spec: {
      includedNamespaces: selected?.length ? selected : ['*'], storageLocation,
      ttl: ttl(ttlHours), snapshotVolumes: false, defaultVolumesToFsBackup: false,
    },
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

export function scheduleResource({ name, cron, namespaces: selected, storageLocation, ttlHours, paused }) {
  if (!validName(name)) throw new Error('计划名称必须为 63 字符以内的小写 DNS 名称')
  if (!String(cron || '').trim()) throw new Error('请输入 Cron 表达式')
  return {
    apiVersion: 'velero.io/v1', kind: 'Schedule', metadata: { name },
    spec: { schedule: cron.trim(), paused: Boolean(paused), template: backupResource({ name: 'template', namespaces: selected, storageLocation, ttlHours }).spec },
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
