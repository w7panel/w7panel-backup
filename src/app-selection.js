import { request } from './velero.js'

export const APP_LABEL = 'backup.w7panel.io/app-'
export const OBJECT_LABEL = 'backup.w7panel.io/object-id'

export const appKey = app => `${app.metadata.namespace}/${app.metadata.name}`
export const objectKey = object => `${object.apiVersion}/${object.kind}/${object.namespace}/${object.name}`

export const uniqueObjects = objects => [...new Map(objects.map(object => [objectKey(object), object])).values()]

export function selectedUnion(previous, selected, current) {
  const existing = new Set(previous.map(objectKey))
  return uniqueObjects(current).map(objectKey).filter(key => !existing.has(key) || selected.includes(key))
}

export function annotatedApps(annotations = {}) {
  if (annotations['backup.w7panel.io/appgroups']) {
    try {
      const keys = JSON.parse(annotations['backup.w7panel.io/appgroups'])
      if (Array.isArray(keys)) return keys.filter(key => typeof key === 'string' && key.includes('/'))
    } catch { return [] }
  }
  const { 'backup.w7panel.io/app-namespace': namespace, 'backup.w7panel.io/app-name': name } = annotations
  return namespace && name ? [`${namespace}/${name}`] : []
}

export async function labelId(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function listAppGroups(namespaces) {
  const results = await Promise.allSettled(namespaces.map(namespace => request(`/apis/w7panel.w7.com/v1alpha1/namespaces/${encodeURIComponent(namespace)}/appgroups`)))
  if (results.length && results.every(result => result.status === 'rejected')) throw results[0].reason
  return results.flatMap(result => result.value.items || []).sort((a, b) => appKey(a).localeCompare(appKey(b)))
}

export function appObjects(app) {
  const values = (app.status?.deployInfo || []).flatMap(item => item.resourcesList || []).map(item => ({
    apiVersion: item.apiVersion, kind: item.kind, namespace: item.namespace || app.metadata.namespace, name: item.name,
  }))
  values.unshift({ apiVersion: app.apiVersion || 'w7panel.w7.com/v1alpha1', kind: 'AppGroup', namespace: app.metadata.namespace, name: app.metadata.name })
  return [...new Map(values.filter(item => item.apiVersion && item.kind && item.namespace && item.name).map(item => [objectKey(item), item])).values()]
}

const discoveryCache = new Map()
async function apiPath(object) {
  const [group, version] = object.apiVersion.includes('/') ? object.apiVersion.split('/') : ['', object.apiVersion]
  const base = group ? `/apis/${group}/${version}` : `/api/${version}`
  if (!discoveryCache.has(base)) discoveryCache.set(base, request(base))
  const discovery = await discoveryCache.get(base)
  const resource = (discovery.resources || []).find(item => item.kind === object.kind && !item.name.includes('/') && item.verbs?.includes('patch'))
  if (!resource) throw new Error(`无法定位资源 ${object.kind} ${object.namespace}/${object.name}`)
  return `${base}${resource.namespaced ? `/namespaces/${encodeURIComponent(object.namespace)}` : ''}/${resource.name}/${encodeURIComponent(object.name)}`
}

export async function liveAppObjects(app) {
  const values = []
  for (const object of appObjects(app)) {
    try {
      await request(await apiPath(object))
      values.push(object)
    } catch (cause) {
      if (cause.status !== 404) throw cause
    }
  }
  return values
}

export async function markObjects(app, objects) {
  const appId = await labelId(appKey(app))
  const marked = []
  for (const object of objects) {
    const id = await labelId(objectKey(object))
    const path = await apiPath(object)
    await request(path, { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify({ metadata: { labels: { [`${APP_LABEL}${appId}`]: 'true', [OBJECT_LABEL]: id } } }) })
    marked.push({ ...object, id })
  }
  return { appId, objects: marked }
}

export function archivePath(namespace, backupName) {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/w7panel-backup-index/proxy/v1/backups/${encodeURIComponent(backupName)}/objects`
}
