import http from 'node:http'
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { archiveObjects } from './archive.mjs'

const namespace = process.env.POD_NAMESPACE || 'velero'
const api = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443}`
const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')
const appLabel = 'backup.w7panel.io/app-'
const objectLabel = 'backup.w7panel.io/object-id'
const id = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const esc = encodeURIComponent

function appKeys(annotations = {}) {
  if (annotations['backup.w7panel.io/appgroups']) {
    try {
      const keys = JSON.parse(annotations['backup.w7panel.io/appgroups'])
      if (Array.isArray(keys)) return keys.filter(key => typeof key === 'string' && key.includes('/'))
    } catch { return [] }
  }
  const appNamespace = annotations['backup.w7panel.io/app-namespace']
  const appName = annotations['backup.w7panel.io/app-name']
  return appNamespace && appName ? [`${appNamespace}/${appName}`] : []
}

async function k8s(path, method = 'GET', body) {
  const response = await fetch(`${api}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  if (!response.ok) throw new Error(`Kubernetes ${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

function objects(app) {
  const values = (app.status?.deployInfo || []).flatMap(item => item.resourcesList || []).map(item => ({ apiVersion: item.apiVersion, kind: item.kind, namespace: item.namespace || app.metadata.namespace, name: item.name }))
  values.unshift({ apiVersion: app.apiVersion || 'w7panel.w7.com/v1alpha1', kind: 'AppGroup', namespace: app.metadata.namespace, name: app.metadata.name })
  return [...new Map(values.filter(item => item.apiVersion && item.kind && item.namespace && item.name).map(item => [`${item.apiVersion}/${item.kind}/${item.namespace}/${item.name}`, item])).values()]
}

const discovery = new Map()
async function resourcePath(object) {
  const [group, version] = object.apiVersion.includes('/') ? object.apiVersion.split('/') : ['', object.apiVersion]
  const base = group ? `/apis/${group}/${version}` : `/api/${version}`
  if (!discovery.has(base)) discovery.set(base, await k8s(base))
  const resource = discovery.get(base).resources?.find(item => item.kind === object.kind && !item.name.includes('/') && item.verbs?.includes('patch'))
  if (!resource) throw new Error(`No patchable resource for ${object.apiVersion}/${object.kind}`)
  return `${base}${resource.namespaced ? `/namespaces/${esc(object.namespace)}` : ''}/${resource.name}/${esc(object.name)}`
}

async function syncSchedule(schedule) {
  for (const key of appKeys(schedule.metadata.annotations)) {
    const [appNamespace, appName] = key.split('/')
    const app = await k8s(`/apis/w7panel.w7.com/v1alpha1/namespaces/${esc(appNamespace)}/appgroups/${esc(appName)}`)
    const appId = id(key)
    for (const object of objects(app)) {
      const path = await resourcePath(object)
      let current
      try { current = await k8s(path) } catch (error) { if (error.message.includes(': 404 ')) continue; throw error }
      const objectId = id(`${object.apiVersion}/${object.kind}/${object.namespace}/${object.name}`)
      if (current.metadata?.labels?.[`${appLabel}${appId}`] === 'true' && current.metadata?.labels?.[objectLabel] === objectId) continue
      await k8s(path, 'PATCH', { metadata: { labels: { [`${appLabel}${appId}`]: 'true', [objectLabel]: objectId } } })
    }
  }
}

async function reconcile() {
  try {
    const schedules = await k8s(`/apis/velero.io/v1/namespaces/${esc(namespace)}/schedules`)
    for (const schedule of schedules.items || []) {
      if (!appKeys(schedule.metadata.annotations).length) continue
      const path = `/apis/velero.io/v1/namespaces/${esc(namespace)}/schedules/${esc(schedule.metadata.name)}`
      const annotations = schedule.metadata.annotations || {}
      try {
        await syncSchedule(schedule)
        if (annotations['backup.w7panel.io/sync-error'] || annotations['backup.w7panel.io/paused-by-index']) {
          await k8s(path, 'PATCH', { metadata: { annotations: { 'backup.w7panel.io/sync-error': null, 'backup.w7panel.io/paused-by-index': null } }, ...(annotations['backup.w7panel.io/paused-by-index'] ? { spec: { paused: false } } : {}) })
        }
      } catch (error) {
        console.error(`Schedule ${schedule.metadata.name}:`, error)
        await k8s(path, 'PATCH', { metadata: { annotations: { 'backup.w7panel.io/sync-error': String(error.message).slice(0, 180), ...(schedule.spec?.paused ? {} : { 'backup.w7panel.io/paused-by-index': 'true' }) } }, spec: { paused: true } }).catch(console.error)
      }
    }
  } catch (error) { console.error('Schedule reconciliation:', error) }
}

async function backupIndex(name) {
  const backup = await k8s(`/apis/velero.io/v1/namespaces/${esc(namespace)}/backups/${esc(name)}`)
  const annotations = backup.metadata?.annotations || {}
  const appIds = appKeys(annotations).map(id).concat(
    [backup.spec?.labelSelector, ...(backup.spec?.orLabelSelectors || [])].flatMap(selector => Object.keys(selector?.matchLabels || {}).filter(key => key.startsWith(appLabel)).map(key => key.slice(appLabel.length)))
  )
  if (!appIds.length) return []
  const requestName = `index-${randomBytes(6).toString('hex')}`
  const base = `/apis/velero.io/v1/namespaces/${esc(namespace)}/downloadrequests`
  await k8s(base, 'POST', { apiVersion: 'velero.io/v1', kind: 'DownloadRequest', metadata: { name: requestName, namespace }, spec: { target: { kind: 'BackupContents', name } } })
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const request = await k8s(`${base}/${requestName}`)
      if (request.status?.downloadURL) return archiveObjects(request.status.downloadURL, [...new Set(appIds)])
    }
    throw new Error('Backup archive request timed out')
  } finally {
    await k8s(`${base}/${requestName}`, 'DELETE').catch(error => console.error(error))
  }
}

http.createServer(async (req, res) => {
  const match = /^\/v1\/backups\/([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/objects$/.exec(req.url || '')
  if (req.method !== 'GET' || !match) { res.writeHead(404).end(); return }
  try {
    const values = await backupIndex(match[1])
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items: values }))
  } catch (error) {
    console.error(error)
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '无法读取备份归档中的资源清单' }))
  }
}).listen(8080, '0.0.0.0')

await reconcile()
setInterval(reconcile, 30000)
