import { expect, test } from 'vitest'
import { appConfig, appConfigSchema } from './app.ts'

test('Workout keeps its database identity and never enables sync in build configuration', () => {
  expect(appConfig.id).toBe('workout')
  expect(appConfig.basePath).toBe('/apps/workout/')
  expect(appConfig.databaseName).toBe('workout-companion')
  expect(appConfig.sync?.enabled).toBe(false)
  expect(appConfig.sync?.endpoint).toBeUndefined()
})

test('invalid identities, mismatched paths and sync enablement fail closed', () => {
  for (const changes of [
    { id: '../workout' }, { id: 'Workout' }, { id: 'bad--slug' }, { id: 'a'.repeat(49) },
    { basePath: '/' }, { basePath: '/apps/other/' }, { basePath: '/apps/workout' },
    { databaseName: '' }, { sync: { enabled: true } }, { unknown: 'field' },
  ]) expect(appConfigSchema.safeParse({ ...appConfig, ...changes }).success).toBe(false)
})
