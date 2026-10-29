/**
 * CBWorkBench 前端应用入口桥接器 (Legacy & Compatibility Bridge)
 * 核心逻辑已按照现代工程化架构拆解至 ./js/ 模块目录：
 *  - ./js/main.js        应用主装配器与挂载入口
 *  - ./js/api.js         API 数据通信层
 *  - ./js/store.js       响应式状态中心
 *  - ./js/router.js      前端路由分发控制器
 *  - ./js/utils.js       格式化与 Markdown 渲染工具
 *  - ./js/components/    功能组件 (TaskList, TaskDetail, RuntimeView)
 */

import { app } from './js/main.js';

export { app };
