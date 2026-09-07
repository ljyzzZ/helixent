import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "Helixent 教程",
  description: "从零构建可观测、可恢复、可评测的 Coding Agent Harness",
  cleanUrls: true,
  rewrites: { "README.md": "index.md" },
  themeConfig: {
    nav: [{ text: "课程首页", link: "/" }],
    sidebar: [
      { text: "课程介绍", link: "/" },
      { text: "第一部分：工程基础与 Foundation", link: "/part-1-foundation" },
      { text: "第二部分：Agent Runtime", link: "/part-2-agent-runtime" },
      { text: "第三部分：Coding Agent 与交互客户端", link: "/part-3-coding-agent" },
      { text: "第四部分：可观测、可恢复与可靠运行", link: "/part-4-production-runtime" },
      { text: "第五部分：评测闭环与作品集交付", link: "/part-5-evaluation" },
      { text: "附录：阶段验收清单", link: "/stage-checklists" },
    ],
    outline: { level: [2, 3], label: "本页目录" },
    search: { provider: "local" },
    docFooter: { prev: "上一章", next: "下一章" },
    sidebarMenuLabel: "章节导航",
    returnToTopLabel: "返回顶部",
  },
});
