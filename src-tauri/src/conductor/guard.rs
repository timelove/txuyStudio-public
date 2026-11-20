//! guard:投递闸门(纯逻辑,吃 ConductorData;registry 存活/空闲判定在命令层组合)。
//!
//! 设计 §5 六条的 P1 子集:
//! - **总闸** `allow_orchestrator`:false = LLM 自发/自动环节全不出(驿站手动投递豁免);
//! - **占用锁**:人 N 分钟内碰过的会话,dispatch 降级为建议卡(手动/自动同查——
//!   人正在用的会话不该被后台塞话);
//! - ~~代批禁令~~ → 2026-11-12 用户拍板反转,改由 `autopilot` 做**分级代批**
//!   (白名单内自动批、危险/未知转人);机器代批不登记人触达,不续占用锁。
//! - 解析失败丢弃在 brain 提示词与解析层落实;预算闸 P2 随常驻循环启用。

use super::ConductorData;

/// 投递闸门判定结果。
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchGate {
    /// 放行(命令层继续做目标存在/空闲检查后发送)。
    Allow,
    /// 目标被占用(人 touch 在锁窗内)→ 调用方降级为建议卡。
    Occupied { touch_ms_ago: i64 },
    /// 总闸关闭,LLM 环节拒绝(仅 `manual=false` 时可能出现)。
    GateClosed,
}

/// 投递前闸门检查。`manual`=true(用户手点)豁免总闸,但占用锁照查。
/// `(project_id, session_id)` 为投递目标会话(touches 按复合键查,tabId 跨项目撞名)。
pub fn check_dispatch(
    data: &ConductorData,
    project_id: &str,
    session_id: &str,
    manual: bool,
    now_ms: i64,
) -> DispatchGate {
    if !manual && !data.config.allow_orchestrator {
        return DispatchGate::GateClosed;
    }
    if let Some(touch) = data.touches.get(&super::skey(project_id, session_id)).copied() {
        if touch > 0 {
            let lock_ms = (data.config.occupied_lock_minutes * 60_000) as i64;
            let ago = now_ms - touch;
            if ago >= 0 && ago < lock_ms {
                return DispatchGate::Occupied { touch_ms_ago: ago };
            }
        }
    }
    DispatchGate::Allow
}
