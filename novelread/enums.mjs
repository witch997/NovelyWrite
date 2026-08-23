/**
 * enums.mjs — novelread 层枚举定义（标注/校验/修复共用，单一事实源）
 *
 * 由 host-exec / fix / check-chapter 统一 import，消除三处重复定义漂移。
 * 全部为数组（.includes 可用）；check-chapter 若需 Set 可自行 new Set(...) 包一层。
 */
export const STRUCTS = ["短句", "句从"];
export const SHOT_TYPES = ["信息", "对话", "心理", "动作", "事件", "环境"];
export const SHOT_FUNCS = ["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"];
export const CHAPTER_FUNCS = ["开端", "推进", "铺垫", "爆发", "转折", "收束章节", "过渡"];
export const MAINLINE_STATES = ["主线启动", "推进", "受阻", "达成", "更换"];
export const TARGET_STATES = ["确立", "推进", "达成", "搁置", "失败"];
