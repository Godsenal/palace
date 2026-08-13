import { powerMonitor, powerSaveBlocker } from 'electron'

/**
 * 시스템 슬립 차단 — "폰에서 항상 붙는다"의 실질.
 *
 * cmux-remote 같은 도구는 서버가 떠 있어도 맥이 잠들면 소용이 없다. 잠든 맥은 tailnet 에서
 * 통째로 사라져서 폰은 연결 자체를 못 한다. 그런데 맥의 기본 슬립 타이머는 자리를 비운 지
 * 몇 분이면 잠재우고, 그 시점은 정확히 폰을 꺼내드는 시점이다.
 *
 * 그래서 '항상 깨어있기'를 켠 앱이 하나라도 실행 중이면 그동안 어서션을 잡는다.
 * - 'prevent-app-suspension' 은 시스템 슬립만 막고 디스플레이는 그대로 꺼진다(= caffeinate -s).
 * - 배터리에서는 잡지 않는다. 전원 없이 밤새 깨어있는 건 얻는 것보다 비싸다.
 *
 * 이 어서션은 palace 가 떠 있는 동안만 유효하다 — 도구 자신의 supervisor(cmux-remote 의
 * run.sh 는 caffeinate -s 를 직접 잡는다)와 겹쳐도 무해하다. 둘 다 있으면 palace 를 꺼도
 * 도구가 살아있는 한 맥은 깨어있다.
 */

let blockerId: number | null = null

/** 지금 어서션을 원하는 앱들(= 켜짐 + 실행중)을 받아 실제 상태를 맞춘다. */
export function syncKeepAwake(holders: string[]): void {
  const want = holders.length > 0 && !powerMonitor.onBatteryPower
  if (want && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

/** 지금 실제로 슬립을 막고 있는가. */
export function isKeepingAwake(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

export function isOnBatteryPower(): boolean {
  return powerMonitor.onBatteryPower
}

/**
 * AC↔배터리 전환은 어서션 유지 여부를 뒤집는다(그리고 UI 의 '왜 안 잡고 있는지'도 바뀐다).
 * 다음 폴링까지 기다리지 말고 즉시 재계산하게 한다.
 */
export function watchPowerSource(onChange: () => void): void {
  powerMonitor.on('on-ac', onChange)
  powerMonitor.on('on-battery', onChange)
}
