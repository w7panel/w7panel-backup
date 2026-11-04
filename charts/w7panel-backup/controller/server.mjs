import http from 'node:http'
import fs from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { archiveAppGroups, archiveInventory, archiveObjects } from './archive.mjs'
import { referencedObjects } from './references.mjs'
import { releaseFromSecret, releaseObjects } from './helm.mjs'

const namespace = process.env.POD_NAMESPACE || 'velero'
const localTest = process.env.LOCAL_TEST === '1'
const api = localTest ? `http://127.0.0.1:${process.env.KUBE_PROXY_PORT || 8013}` : `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443}`
const token = localTest ? '' : fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')
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
  const response = await fetch(`${api}${path}`, { method, headers: { ...(localTest ? {} : { Authorization: `Bearer ${token}` }), ...(body ? { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  if (!response.ok) throw new Error(`Kubernetes ${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

function objects(app) {
  const values = (app.status?.deployInfo || []).flatMap(item => item.resourcesList || []).map(item => ({ apiVersion: item.apiVersion, kind: item.kind, namespace: item.namespace || app.metadata.namespace, name: item.name, optional: item.kind === 'Job' } ))
  values.push(...(app.status?.items || []).map(item => ({ apiVersion: item.apiVersion, kind: item.kind, namespace: app.metadata.namespace, name: item.name, optional: item.kind === 'Job' })))
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
  return { path: `${base}${resource.namespaced ? `/namespaces/${esc(object.namespace)}` : ''}/${resource.name}/${esc(object.name)}`, namespaced: resource.namespaced }
}

async function helmObjects(app) {
  if (!app.spec?.isHelm) return []
  const name = app.metadata.name
  const list = await k8s(`/api/v1/namespaces/${esc(app.metadata.namespace)}/secrets?labelSelector=${esc(`owner=helm,name=${name}`)}`)
  const secrets = (list.items || []).filter(item => item.type === 'helm.sh/release.v1' && item.metadata.labels?.name === name)
  if (!secrets.length) throw new Error(`Helm release missing for ${app.metadata.namespace}/${name}`)
  const releases = secrets.map(releaseFromSecret).sort((a, b) => (b.version || 0) - (a.version || 0))
  const active = releases.find(release => release.info?.status === 'deployed') || releases[0]
  return [
    ...secrets.map(secret => ({ apiVersion: 'v1', kind: 'Secret', namespace: secret.metadata.namespace, name: secret.metadata.name, helmRelease: true })),
    ...releaseObjects(active),
  ]
}

async function liveObjects(app) {
  const pending = [app]
  const values = []
  const seenGroups = new Set()
  while (pending.length) {
    const group = pending.shift()
    const key = `${group.metadata.namespace}/${group.metadata.name}`
    if (seenGroups.has(key)) continue
    seenGroups.add(key)
    values.push(...objects(group), ...await helmObjects(group))
    const children = await k8s(`/apis/w7panel.w7.com/v1alpha1/namespaces/${esc(group.metadata.namespace)}/appgroups?labelSelector=${esc(`w7.cc/parent=${group.metadata.name}`)}`)
    pending.push(...(children.items || []))
  }
  const found = []
  const seen = new Set()
  for (let index = 0; index < values.length; index++) {
    const candidate = values[index]
    const { path, namespaced } = await resourcePath(candidate)
    const object = { ...candidate, namespace: namespaced ? candidate.namespace : '' }
    const key = `${object.apiVersion}/${object.kind}/${object.namespace}/${object.name}`
    if (seen.has(key)) continue
    seen.add(key)
    let current
    try { current = await k8s(path) } catch (error) { if (error.message.includes(': 404 ') && candidate.optional) continue; if (error.message.includes(': 404 ')) throw new Error(`Resource missing: ${object.kind} ${object.namespace}/${object.name}`); throw error }
    found.push(object)
    values.push(...referencedObjects({ ...current, kind: object.kind, metadata: { ...current.metadata, namespace: object.namespace } }).map(item => ({ ...item, optional: true })))
  }
  return found
}

async function syncSchedule(schedule) {
  for (const key of appKeys(schedule.metadata.annotations)) {
    const [appNamespace, appName] = key.split('/')
    const app = await k8s(`/apis/w7panel.w7.com/v1alpha1/namespaces/${esc(appNamespace)}/appgroups/${esc(appName)}`)
    const appId = id(key)
    for (const object of await liveObjects(app)) {
      const { path } = await resourcePath(object)
      const current = await k8s(path)
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
  await reconcileRestores().catch(error => console.error('Restore reconciliation:', error))
}

async function withDownload(kind, name, visit) {
  const requestName = `index-${randomBytes(6).toString('hex')}`
  const base = `/apis/velero.io/v1/namespaces/${esc(namespace)}/downloadrequests`
  await k8s(base, 'POST', { apiVersion: 'velero.io/v1', kind: 'DownloadRequest', metadata: { name: requestName, namespace }, spec: { target: { kind, name } } })
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const request = await k8s(`${base}/${requestName}`)
      if (request.status?.downloadURL) return await visit(request.status.downloadURL)
    }
    throw new Error('Backup archive request timed out')
  } finally {
    await k8s(`${base}/${requestName}`, 'DELETE').catch(error => console.error(error))
  }
}

const withArchive = (name, visit) => withDownload('BackupContents', name, visit)

async function downloadJson(kind, name) {
  return withDownload(kind, name, async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`Restore result download failed: ${response.status}`)
    return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())))
  })
}

async function restoreResults(name) {
  const [resources, results] = await Promise.all([downloadJson('RestoreResourceList', name), downloadJson('RestoreResults', name)])
  return {
    items: Object.entries(resources).flatMap(([resource, values]) => values.map(value => ({ resource, name: value, status: /\(failed\)$/.test(value) ? 'Failed' : /\(skipped\)$/.test(value) ? 'Skipped' : 'Restored' }))),
    errors: Object.values(results.errors?.namespaces || {}).flat(),
    warnings: Object.values(results.warnings?.namespaces || {}).flat(),
  }
}

async function backupIndex(name) {
  const backup = await k8s(`/apis/velero.io/v1/namespaces/${esc(namespace)}/backups/${esc(name)}`)
  const annotations = backup.metadata?.annotations || {}
  const appIds = appKeys(annotations).map(id).concat(
    [backup.spec?.labelSelector, ...(backup.spec?.orLabelSelectors || [])].flatMap(selector => Object.keys(selector?.matchLabels || {}).filter(key => key.startsWith(appLabel)).map(key => key.slice(appLabel.length)))
  )
  return appIds.length ? withArchive(name, url => archiveObjects(url, [...new Set(appIds)])) : []
}

async function reconcileRestores() {
  const restores = await k8s(`/apis/velero.io/v1/namespaces/${esc(namespace)}/restores`)
  for (const restore of restores.items || []) {
    const annotations = restore.metadata.annotations || {}
    if (annotations['backup.w7panel.io/hydrate-appgroups'] !== 'true' || annotations['backup.w7panel.io/hydrated'] === 'true') continue
    if (!['Completed', 'PartiallyFailed', 'Failed'].includes(restore.status?.phase) || !restore.status?.startTimestamp) continue
    const path = `/apis/velero.io/v1/namespaces/${esc(namespace)}/restores/${esc(restore.metadata.name)}`
    try {
      const existing = new Set(JSON.parse(annotations['backup.w7panel.io/existing-appgroups'] || '[]'))
      const ids = (restore.spec.orLabelSelectors || []).map(selector => selector.matchLabels?.[objectLabel]).filter(Boolean)
      const groups = await withArchive(restore.spec.backupName, url => archiveAppGroups(url, ids))
      for (const group of groups) {
        const targetNamespace = restore.spec.namespaceMapping?.[group.metadata.namespace] || group.metadata.namespace
        if (existing.has(`${targetNamespace}/${group.metadata.name}`)) continue
        const groupPath = `/apis/w7panel.w7.com/v1alpha1/namespaces/${esc(targetNamespace)}/appgroups/${esc(group.metadata.name)}`
        let current
        try { current = await k8s(groupPath) } catch (error) { if (error.message.includes(': 404 ')) continue; throw error }
        if (current.metadata.labels?.[objectLabel] !== group.metadata.labels?.[objectLabel]) continue
        if (Date.parse(current.metadata.creationTimestamp) < Date.parse(restore.status.startTimestamp)) continue
        if (!current.status?.deployInfo?.length && group.status) await k8s(groupPath, 'PATCH', { status: group.status })
      }
      await k8s(path, 'PATCH', { metadata: { annotations: { 'backup.w7panel.io/hydrated': 'true', 'backup.w7panel.io/hydration-error': null } } })
    } catch (error) {
      await k8s(path, 'PATCH', { metadata: { annotations: { 'backup.w7panel.io/hydration-error': String(error.message).slice(0, 180) } } }).catch(console.error)
    }
  }
}

http.createServer(async (req, res) => {
  const appMatch = /^\/v1\/apps\/([a-z0-9-]+)\/([a-z0-9-]+)\/objects$/.exec(req.url || '')
  const match = /^\/v1\/backups\/([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/objects$/.exec(req.url || '')
  const inventoryMatch = /^\/v1\/backups\/([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/inventory$/.exec(req.url || '')
  const restoreMatch = /^\/v1\/restores\/([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/results$/.exec(req.url || '')
  if (req.method !== 'GET' || (!match && !appMatch && !inventoryMatch && !restoreMatch)) { res.writeHead(404).end(); return }
  try {
    if (restoreMatch) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await restoreResults(restoreMatch[1]))); return }
    const values = appMatch
      ? await liveObjects(await k8s(`/apis/w7panel.w7.com/v1alpha1/namespaces/${esc(appMatch[1])}/appgroups/${esc(appMatch[2])}`))
      : inventoryMatch ? await withArchive(inventoryMatch[1], archiveInventory) : await backupIndex(match[1])
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items: values }))
  } catch (error) {
    console.error(error)
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: appMatch ? String(error.message).slice(0, 300) : '无法读取备份归档中的资源清单' }))
  }
}).listen(localTest ? Number(process.env.INDEX_PORT || 18023) : 8080, localTest ? '127.0.0.1' : '0.0.0.0')

await reconcile()
setInterval(reconcile, 30000)
