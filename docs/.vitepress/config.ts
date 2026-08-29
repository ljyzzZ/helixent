import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "Helixent",
  description: "Helixent 文档与 Coding Agent 教程",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "教程", link: "/tutorial/" },
      { text: "Foundation", link: "/foundation" },
    ],
    sidebar: {
      "/tutorial/": [
        {
          text: "Coding Agent Harness 教程",
          items: [
            { text: "课程介绍", link: "/tutorial/" },
            {
              text: "第零部分：TypeScript 必备基础",
              link: "/tutorial/part-0-typescript-basics",
            },
            { text: "第一部分：Foundation", link: "/tutorial/part-1-foundation" },
            { text: "第二部分：Agent Runtime", link: "/tutorial/part-2-agent-runtime" },
            { text: "第三部分：Coding Agent", link: "/tutorial/part-3-coding-agent" },
            {
              text: "第四部分：Production Runtime",
              link: "/tutorial/part-4-production-runtime",
            },
            { text: "第五部分：Evaluation", link: "/tutorial/part-5-evaluation" },
            { text: "阶段验收清单", link: "/tutorial/stage-checklists" },
          ],
        },
      ],
    },
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
      label: "本页目录",
    },
    docFooter: {
      prev: "上一篇",
      next: "下一篇",
    },
    lastUpdated: {
      text: "最后更新于",
    },
  },
});
