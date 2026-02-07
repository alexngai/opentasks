import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createConnection,
  checkConnectionHealth,
  addConnection,
  removeConnection,
  findConnection,
  checkAllConnectionHealth,
  type Connection,
} from '../connections.js'

let tmpDir: string

function setupLocation(name: string, hash: string): string {
  const dir = path.join(tmpDir, name, '.opentasks')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: '1.0',
      location: {
        hash,
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        name,
      },
    })
  )
  return dir
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('createConnection', () => {
  it('reads target config and creates connection', () => {
    const targetDir = setupLocation('other-repo', 'k7m2x9p4')
    const baseDir = path.join(tmpDir, 'my-repo', '.opentasks')
    fs.mkdirSync(baseDir, { recursive: true })

    const connection = createConnection(targetDir, 'peer', baseDir)
    expect(connection.hash).toBe('k7m2x9p4')
    expect(connection.name).toBe('other-repo')
    expect(connection.role).toBe('peer')
  })

  it('throws on non-existent target', () => {
    expect(() =>
      createConnection('/nonexistent/.opentasks')
    ).toThrow('Cannot read config')
  })

  it('throws on target without location identity', () => {
    const dir = path.join(tmpDir, 'bad', '.opentasks')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}))

    expect(() =>
      createConnection(dir)
    ).toThrow('No valid location identity')
  })

  it('uses absolute path when no basePath provided', () => {
    const targetDir = setupLocation('target', 'abc12345')
    const connection = createConnection(targetDir)
    expect(path.isAbsolute(connection.path)).toBe(true)
  })
})

describe('checkConnectionHealth', () => {
  it('returns reachable for valid connection', () => {
    const targetDir = setupLocation('target', 'abc12345')
    const connection: Connection = {
      hash: 'abc12345',
      path: targetDir,
      role: 'peer',
      name: 'target',
    }

    const status = checkConnectionHealth(connection)
    expect(status.health).toBe('reachable')
    expect(status.error).toBeUndefined()
  })

  it('returns unreachable for non-existent path', () => {
    const connection: Connection = {
      hash: 'abc12345',
      path: '/nonexistent/.opentasks',
      role: 'peer',
      name: 'missing',
    }

    const status = checkConnectionHealth(connection)
    expect(status.health).toBe('unreachable')
    expect(status.error).toContain('does not exist')
  })

  it('returns hash-mismatch when hash changed', () => {
    const targetDir = setupLocation('target', 'different')
    const connection: Connection = {
      hash: 'abc12345',
      path: targetDir,
      role: 'peer',
      name: 'target',
    }

    const status = checkConnectionHealth(connection)
    expect(status.health).toBe('hash-mismatch')
    expect(status.error).toContain('Expected hash abc12345')
  })
})

describe('addConnection', () => {
  it('adds a new connection', () => {
    const existing: Connection[] = []
    const newConn: Connection = {
      hash: 'abc12345',
      path: '/some/path',
      role: 'peer',
      name: 'new',
    }

    const result = addConnection(existing, newConn)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(newConn)
  })

  it('replaces existing connection with same hash', () => {
    const existing: Connection[] = [
      { hash: 'abc12345', path: '/old/path', role: 'peer', name: 'old' },
    ]
    const newConn: Connection = {
      hash: 'abc12345',
      path: '/new/path',
      role: 'parent',
      name: 'updated',
    }

    const result = addConnection(existing, newConn)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('/new/path')
    expect(result[0].role).toBe('parent')
  })
})

describe('removeConnection', () => {
  it('removes by hash', () => {
    const connections: Connection[] = [
      { hash: 'aaa11111', path: '/a', role: 'peer', name: 'a' },
      { hash: 'bbb22222', path: '/b', role: 'peer', name: 'b' },
    ]

    const result = removeConnection(connections, 'aaa11111')
    expect(result).toHaveLength(1)
    expect(result[0].hash).toBe('bbb22222')
  })

  it('returns unchanged list if hash not found', () => {
    const connections: Connection[] = [
      { hash: 'aaa11111', path: '/a', role: 'peer', name: 'a' },
    ]

    const result = removeConnection(connections, 'notfound')
    expect(result).toHaveLength(1)
  })
})

describe('findConnection', () => {
  it('finds by hash', () => {
    const connections: Connection[] = [
      { hash: 'aaa11111', path: '/a', role: 'peer', name: 'a' },
      { hash: 'bbb22222', path: '/b', role: 'peer', name: 'b' },
    ]

    expect(findConnection(connections, 'bbb22222')?.name).toBe('b')
    expect(findConnection(connections, 'notfound')).toBeUndefined()
  })
})

describe('checkAllConnectionHealth', () => {
  it('returns status for all connections', () => {
    const targetDir = setupLocation('target', 'abc12345')
    const connections: Connection[] = [
      { hash: 'abc12345', path: targetDir, role: 'peer', name: 'target' },
      { hash: 'xyz99999', path: '/nonexistent', role: 'peer', name: 'missing' },
    ]

    const statuses = checkAllConnectionHealth(connections)
    expect(statuses).toHaveLength(2)
    expect(statuses[0].health).toBe('reachable')
    expect(statuses[1].health).toBe('unreachable')
  })
})
