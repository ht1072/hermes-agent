import { registryBackendScopeKey } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'

import {
  $activeSessionId,
  $awaitingResponse,
  $busy,
  $selectedStoredSessionId,
  $unreadFinishedSessionIds
} from './session'
import {
  $attentionSessionIds,
  $sessionStates,
  $stalledSessionIds,
  $workingSessionIds,
  captureBusyStatesForReconnect,
  clearAllSessionStates,
  publishSessionState,
  reconcileBusyStatesOnReconnect,
  recordSessionEventScope,
  SESSION_WATCHDOG_TIMEOUT_MS,
  type SessionTileDelegate,
  setSessionTileDelegate
} from './session-states'

function state(over: Partial<ClientSessionState> = {}): ClientSessionState {
  return { ...createClientSessionState(null), storedSessionId: 's1', ...over }
}

// Stand-in for the wiring layer's `retireBusyClaim`: cache keyed by runtime
// id, miss (or idle) → false and no write, hit → write + mirror publish. No
// unset API exists, so `noDelegate` (empty cache) plays "no wiring mounted".
function tileDelegate(cache: Map<string, ClientSessionState>): SessionTileDelegate {
  return {
    retireBusyClaim: runtimeId => {
      const cached = cache.get(runtimeId)

      if (!cached || (!cached.busy && !cached.awaitingResponse)) {
        return false
      }

      const next = { ...cached, awaitingResponse: false, busy: false }

      cache.set(runtimeId, next)
      publishSessionState(runtimeId, next)

      return true
    }
  } as SessionTileDelegate
}

const noDelegate = tileDelegate(new Map())

// The stale-flag half of #53902/#73082: a backend respawn re-mints runtime
// ids, so a pre-reconnect busy state never receives its terminal busy:false
// and the session's running arc stays armed forever. The reconnect paths call
// reconcileBusyStatesOnReconnect to retire those claims.
describe('reconcileBusyStatesOnReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    clearAllSessionStates()
    $unreadFinishedSessionIds.set([])
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)
    $busy.set(false)
    $awaitingResponse.set(false)
    setSessionTileDelegate(noDelegate)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    clearAllSessionStates()
    $unreadFinishedSessionIds.set([])
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)
    $busy.set(false)
    $awaitingResponse.set(false)
    setSessionTileDelegate(noDelegate)
  })

  it('clears a stale busy session on primary reconnect', () => {
    publishSessionState('rt1', state({ busy: true, storedSessionId: 's1' }))
    expect($workingSessionIds.get()).toContain('s1')

    reconcileBusyStatesOnReconnect()

    expect($workingSessionIds.get()).not.toContain('s1')
  })

  it('disarms the stall watchdog with the busy claim', () => {
    publishSessionState('rt1', state({ busy: true, storedSessionId: 's1' }))

    reconcileBusyStatesOnReconnect()

    // Without reconcile the watchdog would fire and paint s1 stalled.
    vi.advanceTimersByTime(SESSION_WATCHDOG_TIMEOUT_MS + 1000)
    expect($stalledSessionIds.get()).not.toContain('s1')
  })

  it('preserves needsInput — a blocking prompt is not a stale flag', () => {
    publishSessionState('rt1', state({ busy: true, needsInput: true, storedSessionId: 's1' }))
    expect($attentionSessionIds.get()).toContain('s1')

    reconcileBusyStatesOnReconnect()

    expect($workingSessionIds.get()).not.toContain('s1')
    expect($attentionSessionIds.get()).toContain('s1')
  })

  it('primary reconcile leaves registry-scoped sessions alone', () => {
    const scope = registryBackendScopeKey('connA', 'default')
    publishSessionState('rtA', state({ busy: true, storedSessionId: 'sA' }))
    recordSessionEventScope({ connectionId: 'connA', profile: 'default', session_id: 'rtA' })
    publishSessionState('rtLocal', state({ busy: true, storedSessionId: 'sLocal' }))

    reconcileBusyStatesOnReconnect()

    expect($workingSessionIds.get()).toContain('sA')
    expect($workingSessionIds.get()).not.toContain('sLocal')

    // And the scoped variant clears ONLY its own connection's sessions.
    reconcileBusyStatesOnReconnect(scope)
    expect($workingSessionIds.get()).not.toContain('sA')
  })

  it('scoped reconcile does not touch other connections or the primary', () => {
    publishSessionState('rtA', state({ busy: true, storedSessionId: 'sA' }))
    recordSessionEventScope({ connectionId: 'connA', profile: 'default', session_id: 'rtA' })
    publishSessionState('rtB', state({ busy: true, storedSessionId: 'sB' }))
    recordSessionEventScope({ connectionId: 'connB', profile: 'default', session_id: 'rtB' })
    publishSessionState('rtLocal', state({ busy: true, storedSessionId: 'sLocal' }))

    reconcileBusyStatesOnReconnect(registryBackendScopeKey('connA', 'default'))

    expect($workingSessionIds.get()).not.toContain('sA')
    expect($workingSessionIds.get()).toContain('sB')
    expect($workingSessionIds.get()).toContain('sLocal')
  })

  // #93059: the store is a mirror of the wiring cache; downgrading only the
  // mirror leaves the cache busy, and warm resume ORs it over `running: false`.
  it('routes the downgrade through the session-state write path (#93059)', () => {
    const cache = new Map<string, ClientSessionState>()
    const stale = state({ awaitingResponse: true, busy: true, storedSessionId: 's1' })

    cache.set('rt1', stale)
    publishSessionState('rt1', stale)
    setSessionTileDelegate(tileDelegate(cache))
    expect($workingSessionIds.get()).toContain('s1')

    reconcileBusyStatesOnReconnect()

    expect(cache.get('rt1')?.busy).toBe(false)
    expect(cache.get('rt1')?.awaitingResponse).toBe(false)
    expect($workingSessionIds.get()).not.toContain('s1')
  })

  // Cache miss (background-profile rows, cold window): the mirror is still
  // retired and nothing is minted in the cache.
  it('falls back to the mirror when the write path has no state for the runtime', () => {
    const cache = new Map<string, ClientSessionState>()

    publishSessionState('rt1', state({ busy: true, storedSessionId: 's1' }))
    setSessionTileDelegate(tileDelegate(cache))

    reconcileBusyStatesOnReconnect()

    expect(cache.has('rt1')).toBe(false)
    expect($workingSessionIds.get()).not.toContain('s1')
  })

  // With no live slice, PRIMARY_SESSION_VIEW and busyRef fall back to the
  // draft latches — a stuck one silently no-ops Send until restart (#93059).
  it('retires the focused composer latches on primary reconnect (#93059)', () => {
    $busy.set(true)
    $awaitingResponse.set(true)

    reconcileBusyStatesOnReconnect()

    expect($busy.get()).toBe(false)
    expect($awaitingResponse.get()).toBe(false)
  })

  it('a scoped reconcile leaves the focused composer alone', () => {
    // A background socket returning says nothing about the primary composer.
    $busy.set(true)
    $awaitingResponse.set(true)

    reconcileBusyStatesOnReconnect(registryBackendScopeKey('connA', 'default'))

    expect($busy.get()).toBe(true)
    expect($awaitingResponse.get()).toBe(true)
  })

  it('does not retire a fresh active claim published after the reconnect snapshot', () => {
    const stale = state({ awaitingResponse: true, busy: true, storedSessionId: 'stale-session' })
    publishSessionState('stale-runtime', stale)
    const staleSnapshot = captureBusyStatesForReconnect()

    publishSessionState(
      'fresh-runtime',
      state({ awaitingResponse: true, busy: true, storedSessionId: 'fresh-session' })
    )
    $activeSessionId.set('fresh-runtime')
    $busy.set(true)
    $awaitingResponse.set(true)

    reconcileBusyStatesOnReconnect(undefined, staleSnapshot)

    expect($sessionStates.get()['fresh-runtime']).toMatchObject({ awaitingResponse: true, busy: true })
    expect($busy.get()).toBe(true)
    expect($awaitingResponse.get()).toBe(true)
  })

  it('moves a legacy secondary runtime back to primary ownership explicitly', () => {
    const live = state({ busy: true, storedSessionId: 'session-1' })

    publishSessionState('runtime-1', live)
    recordSessionEventScope({ profile: 'selena', session_id: 'runtime-1' }, 'selena')

    reconcileBusyStatesOnReconnect()
    expect($sessionStates.get()['runtime-1']).toBe(live)

    recordSessionEventScope({ profile: 'default', session_id: 'runtime-1' }, null)
    reconcileBusyStatesOnReconnect()

    expect($sessionStates.get()['runtime-1']).toMatchObject({ awaitingResponse: false, busy: false })
  })

  it('preserves a runtime that moves to another socket after the reconnect snapshot', () => {
    const stale = state({ awaitingResponse: true, busy: true, storedSessionId: 'session-1' })
    const cache = new Map<string, ClientSessionState>([['runtime-1', stale]])
    const oldScope = registryBackendScopeKey('connA', 'default')

    publishSessionState('runtime-1', stale)
    recordSessionEventScope({ connectionId: 'connA', profile: 'default', session_id: 'runtime-1' })
    const staleSnapshot = captureBusyStatesForReconnect(oldScope)

    // Fan-in records ownership before an event updater runs. A no-op event can
    // therefore move the runtime to another socket without replacing its state.
    recordSessionEventScope({ connectionId: 'connB', profile: 'default', session_id: 'runtime-1' })
    setSessionTileDelegate(tileDelegate(cache))

    reconcileBusyStatesOnReconnect(oldScope, staleSnapshot)

    expect(cache.get('runtime-1')).toBe(stale)
    expect($sessionStates.get()['runtime-1']).toBe(stale)
  })

  it('does not retire a runtime that republishes after the reconnect snapshot', () => {
    const stale = state({ awaitingResponse: true, busy: true, storedSessionId: 'session-1' })

    publishSessionState('runtime-1', stale)
    const staleSnapshot = captureBusyStatesForReconnect()
    const fresh = state({ awaitingResponse: true, busy: true, storedSessionId: 'session-1' })

    publishSessionState('runtime-1', fresh)
    setSessionTileDelegate(tileDelegate(new Map([['runtime-1', fresh]])))
    $activeSessionId.set('runtime-1')
    $busy.set(true)
    $awaitingResponse.set(true)

    reconcileBusyStatesOnReconnect(undefined, staleSnapshot)

    expect($sessionStates.get()['runtime-1']).toBe(fresh)
    expect($busy.get()).toBe(true)
    expect($awaitingResponse.get()).toBe(true)
  })

  it('a live turn re-asserting busy after reconcile re-arms the arc', () => {
    const s = state({ busy: true, storedSessionId: 's1' })
    publishSessionState('rt1', s)
    reconcileBusyStatesOnReconnect()
    expect($workingSessionIds.get()).not.toContain('s1')

    // The still-alive backend's next event republishes busy under a live id.
    publishSessionState('rt2', state({ busy: true, storedSessionId: 's1' }))

    expect($workingSessionIds.get()).toContain('s1')
  })
})
