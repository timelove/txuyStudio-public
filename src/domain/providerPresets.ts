// 供应商预设表(name/baseUrl/默认模型/官网),从 cc-switch(MIT)的
// claudeProviderPresets.ts / codexProviderPresets.ts 一次性提取生成
// (.work/tmp_extract_presets.ts + .work/tmp_gen_presets.ts,更新源后重跑);
// 已清洗其推广跟踪参数(aff/track_id/invitecode),并过滤 OAuth/hidden 条目
// (我们没有 OAuth 链路)。手改请改提取脚本而不是本文件。
export type ProviderPresetEntry = {
  name: string;
  baseUrl: string;
  model?: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
  category?: string;
};

export const claudeProviderPresets: ProviderPresetEntry[] = [
  {
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/anthropic",
    model: "kimi-k2.7-code",
    websiteUrl: "https://platform.kimi.com",
    category: "cn_official"
  },
  {
    name: "Kimi Global",
    baseUrl: "https://api.moonshot.ai/anthropic",
    model: "kimi-k2.7-code",
    websiteUrl: "https://platform.kimi.ai",
    category: "cn_official"
  },
  {
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/",
    model: "kimi-for-coding",
    websiteUrl: "https://www.kimi.com/code/",
    category: "cn_official"
  },
  {
    name: "Kimi For Coding Global",
    baseUrl: "https://api.kimi.ai/coding/",
    model: "kimi-for-coding",
    websiteUrl: "https://www.kimi.ai/code",
    category: "cn_official"
  },
  {
    name: "PackyCode",
    baseUrl: "https://www.packyapi.ai",
    websiteUrl: "https://www.packyapi.ai",
    apiKeyUrl: "https://www.packyapi.ai/register",
    category: "third_party"
  },
  {
    name: "ZetaAPI",
    baseUrl: "https://api.zetaapi.ai",
    websiteUrl: "https://zetaapi.ai",
    apiKeyUrl: "https://zetaapi.ai/go/u117",
    category: "aggregator"
  },
  {
    name: "APINebula",
    baseUrl: "https://apinebula.ai",
    websiteUrl: "https://apinebula.ai",
    apiKeyUrl: "https://apinebula.ai/VjM74M",
    category: "third_party"
  },
  {
    name: "AICodeMirror",
    baseUrl: "https://api.aicodemirror.ai/api/claudecode",
    websiteUrl: "https://www.aicodemirror.ai",
    apiKeyUrl: "https://www.aicodemirror.ai/register",
    category: "third_party"
  },
  {
    name: "PatewayAI",
    baseUrl: "https://api.pateway.ai",
    websiteUrl: "https://pateway.ai",
    apiKeyUrl: "https://pateway.ai/",
    category: "third_party"
  },
  {
    name: "FennoAI",
    baseUrl: "https://api.fenno.ai",
    websiteUrl: "https://api.fenno.ai",
    apiKeyUrl: "https://api.fenno.ai/register",
    category: "aggregator"
  },
  {
    name: "RunAPI",
    baseUrl: "https://runapi.host",
    websiteUrl: "https://runapi.host",
    apiKeyUrl: "https://runapi.host/register",
    category: "aggregator"
  },
  {
    name: "OpenModel",
    baseUrl: "https://api.openmodel.ai",
    websiteUrl: "https://www.openmodel.ai",
    apiKeyUrl: "https://www.openmodel.ai",
    category: "aggregator"
  },
  {
    name: "GrooRoute Pro",
    baseUrl: "https://grooroute.pro",
    websiteUrl: "https://grooroute.pro",
    apiKeyUrl: "https://grooroute.pro/sign-up",
    category: "aggregator"
  },
  {
    name: "TokenFactory",
    baseUrl: "https://api.tokenfactory.cn/anthropic",
    model: "glm-5.3[1M]",
    websiteUrl: "https://tokenfactory.cn",
    apiKeyUrl: "https://console.tokenfactory.cn/login",
    category: "aggregator"
  },
  {
    name: "Shengsuanyun",
    baseUrl: "https://router.shengsuanyun.com/api",
    model: "anthropic/claude-sonnet-5",
    websiteUrl: "https://www.shengsuanyun.com/",
    apiKeyUrl: "https://www.shengsuanyun.com/",
    category: "aggregator"
  },
  {
    name: "AIGoCode",
    baseUrl: "https://api.aigocode.dev",
    websiteUrl: "https://aigocode.net",
    apiKeyUrl: "https://aigocode.net/invite/CC-SWITCH",
    category: "third_party"
  },
  {
    name: "Qiniu",
    baseUrl: "https://api.qnaigc.com",
    websiteUrl: "https://s.qiniu.com/nMvAvy",
    apiKeyUrl: "https://s.qiniu.com/nMvAvy",
    category: "aggregator"
  },
  {
    name: "AICoding",
    baseUrl: "https://api.aicoding.inc",
    websiteUrl: "https://aicoding.inc",
    apiKeyUrl: "https://aicoding.inc/i/CCSWITCH",
    category: "third_party"
  },
  {
    name: "SubRouter",
    baseUrl: "https://subrouter.ai",
    websiteUrl: "https://subrouter.ai",
    apiKeyUrl: "https://subrouter.ai/register",
    category: "aggregator"
  },
  {
    name: "FluxA Token Plan",
    baseUrl: "https://api.baiduqianfan.ai/anthropic/tokenplan/team",
    model: "deepseek-v4-pro[1M]",
    websiteUrl: "https://agentmarket.fluxapay.xyz/",
    apiKeyUrl: "https://agentmarket.fluxapay.xyz/marketplace/tokenplans",
    category: "aggregator"
  },
  {
    name: "88API",
    baseUrl: "https://api.88api.ai",
    websiteUrl: "https://88api.ai",
    apiKeyUrl: "https://88api.ai/sign-up",
    category: "aggregator"
  },
  {
    name: "APIKEY.FUN",
    baseUrl: "https://api.apikey.fan",
    websiteUrl: "https://apikey.fan",
    apiKeyUrl: "https://apikey.fan/register",
    category: "third_party"
  },
  {
    name: "9527CODE",
    baseUrl: "https://9527.codes",
    websiteUrl: "https://9527.codes",
    apiKeyUrl: "https://9527.codes/register",
    category: "aggregator"
  },
  {
    name: "ClaudeAPI",
    baseUrl: "https://gw.apito.ai",
    websiteUrl: "https://www.apito.ai",
    apiKeyUrl: "https://console.apito.ai/agent/register/pQBql2buaqiX3dDS",
    category: "aggregator"
  },
  {
    name: "Code0",
    baseUrl: "https://code0.ai",
    websiteUrl: "https://code0.ai",
    apiKeyUrl: "https://code0.ai/agent/register/B2XHxGjGmRvqgznY",
    category: "aggregator"
  },
  {
    name: "TeamoRouter",
    baseUrl: "https://api.teamorouter.cn",
    websiteUrl: "https://teamorouter.cn",
    apiKeyUrl: "https://teamorouter.cn/",
    category: "aggregator"
  },
  {
    name: "PPIO",
    baseUrl: "https://api.ppio.com/anthropic",
    model: "deepseek/deepseek-v4-flash-0731[1M]",
    websiteUrl: "https://ppio.com",
    apiKeyUrl: "https://ppio.com/activity/ccswitch",
    category: "aggregator"
  },
  {
    name: "ClaudeCN",
    baseUrl: "https://claudecn.top",
    websiteUrl: "https://claudecn.top",
    apiKeyUrl: "https://claudecn.ai/register",
    category: "third_party"
  },
  {
    name: "火山 Agent Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    model: "ark-code-latest",
    websiteUrl: "https://www.volcengine.com/activity/agentplan",
    apiKeyUrl: "https://www.volcengine.com/activity/agentplan",
    category: "cn_official"
  },
  {
    name: "火山 Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    model: "ark-code-latest",
    websiteUrl: "https://www.volcengine.com/activity/codingplan",
    apiKeyUrl: "https://www.volcengine.com/activity/codingplan",
    category: "cn_official"
  },
  {
    name: "BytePlus",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding",
    model: "ark-code-latest",
    websiteUrl: "https://www.byteplus.com/en/product/modelark",
    apiKeyUrl: "https://www.byteplus.com/en/product/modelark",
    category: "cn_official"
  },
  {
    name: "Volcengine Doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/compatible",
    model: "doubao-seed-2-1-pro-260628",
    websiteUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    category: "cn_official"
  },
  {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn",
    model: "deepseek-ai/DeepSeek-V4-Flash[1M]",
    websiteUrl: "https://siliconflow.cn",
    apiKeyUrl: "https://cloud.siliconflow.cn/i/YflgU2Ve",
    category: "aggregator"
  },
  {
    name: "SiliconFlow en",
    baseUrl: "https://api.siliconflow.com",
    model: "MiniMaxAI/MiniMax-M3[1M]",
    websiteUrl: "https://siliconflow.com",
    apiKeyUrl: "https://cloud.siliconflow.cn/i/YflgU2Ve",
    category: "aggregator"
  },
  {
    name: "A6API",
    baseUrl: "https://api.a6api.com",
    websiteUrl: "https://www.a6api.com",
    apiKeyUrl: "https://a6api.com/register",
    category: "aggregator"
  },
  {
    name: "Compshare",
    baseUrl: "https://api.modelverse.cn",
    websiteUrl: "https://www.compshare.cn",
    apiKeyUrl: "https://www.compshare.cn/coding-plan",
    category: "aggregator"
  },
  {
    name: "Compshare Coding Plan",
    baseUrl: "https://cp.compshare.cn",
    websiteUrl: "https://www.compshare.cn",
    apiKeyUrl: "https://www.compshare.cn/coding-plan",
    category: "aggregator"
  },
  {
    name: "CCSub",
    baseUrl: "https://www.ccsub.net",
    websiteUrl: "https://www.ccsub.net",
    apiKeyUrl: "https://www.ccsub.net/register",
    category: "aggregator"
  },
  {
    name: "SSSAiCode",
    baseUrl: "https://node-hk.sssaicodeapi.com/api",
    websiteUrl: "https://sssaicodeapi.com",
    apiKeyUrl: "https://sssaicodeapi.com/register",
    category: "third_party"
  },
  {
    name: "SoleAPI",
    baseUrl: "https://soleapi.com",
    websiteUrl: "https://soleapi.com",
    apiKeyUrl: "https://soleapi.com/r/ccswitch",
    category: "aggregator"
  },
  {
    name: "Micu",
    baseUrl: "https://www.micuapi.ai",
    websiteUrl: "https://www.micuapi.ai",
    apiKeyUrl: "https://www.micuapi.ai/register",
    category: "third_party"
  },
  {
    name: "RightCode",
    baseUrl: "https://www.rightapi.ai/claude",
    websiteUrl: "https://www.rightapi.ai",
    apiKeyUrl: "https://www.rightapi.ai/register",
    category: "third_party"
  },
  {
    name: "Cubence",
    baseUrl: "https://api.cubence.com",
    websiteUrl: "https://cubence.com",
    apiKeyUrl: "https://cubence.com/signup",
    category: "third_party"
  },
  {
    name: "CrazyRouter",
    baseUrl: "https://cn.crazyrouter.com",
    websiteUrl: "https://www.crazyrouter.com",
    apiKeyUrl: "https://www.crazyrouter.com/register",
    category: "third_party"
  },
  {
    name: "DMXAPI",
    baseUrl: "https://www.dmxapi.cn",
    websiteUrl: "https://www.dmxapi.cn",
    apiKeyUrl: "https://www.dmxapi.cn",
    category: "aggregator"
  },
  {
    name: "SudoCode.chat",
    baseUrl: "https://api.sudocode.chat",
    websiteUrl: "https://sudocode.chat",
    apiKeyUrl: "https://sudocode.chat/sign-up",
    category: "third_party"
  },
  {
    name: "SudoCode.us",
    baseUrl: "https://sudocode.us",
    websiteUrl: "https://sudocode.us",
    apiKeyUrl: "https://sudocode.us",
    category: "third_party"
  },
  {
    name: "XycAi",
    baseUrl: "https://apicdn.xycai.us",
    websiteUrl: "https://xycai.us",
    apiKeyUrl: "https://xycai.us/register",
    category: "aggregator"
  },
  {
    name: "Modelflare",
    baseUrl: "https://modelflare.dev",
    websiteUrl: "https://modelflare.dev",
    apiKeyUrl: "https://modelflare.dev/sign-up",
    category: "aggregator"
  },
  {
    name: "EveryAPI",
    baseUrl: "https://api.everyapi.ai",
    websiteUrl: "https://everyapi.ai",
    apiKeyUrl: "https://app.everyapi.ai/signin",
    category: "aggregator"
  },
  {
    name: "AllTokens",
    baseUrl: "https://alltokens.cc",
    websiteUrl: "https://alltokens.cc",
    apiKeyUrl: "https://alltokens.cc/register",
    category: "aggregator"
  },
  {
    name: "AllTokens SI",
    baseUrl: "https://alltokens.si",
    model: "claude-sonnet-5.5",
    websiteUrl: "https://alltokens.si",
    apiKeyUrl: "https://alltokens.si/enterprise-register",
    category: "aggregator"
  },
  {
    name: "Tu-zi",
    baseUrl: "https://api.tu-zi.com",
    websiteUrl: "https://api.tu-zi.com",
    apiKeyUrl: "https://api.tu-zi.com/token",
    category: "aggregator"
  },
  {
    name: "Amux",
    baseUrl: "https://api.amux.ai",
    websiteUrl: "https://amux.ai",
    apiKeyUrl: "https://amux.ai",
    category: "aggregator"
  },
  {
    name: "AtlasCloud",
    baseUrl: "https://api.atlascloud.ai",
    model: "zai-org/glm-5.1",
    websiteUrl: "https://www.atlascloud.ai/console/coding-plan",
    apiKeyUrl: "https://www.atlascloud.ai/console/coding-plan",
    category: "aggregator"
  },
  {
    name: "Soshow",
    baseUrl: "https://maas.so-show.com",
    websiteUrl: "https://aimarket.so-show.com",
    apiKeyUrl: "https://aimarket.so-show.com/workbench/access-key",
    category: "aggregator"
  },
  {
    name: "Gemini Native",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-3.6-flash",
    websiteUrl: "https://ai.google.dev/gemini-api",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    category: "third_party"
  },
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro[1M]",
    websiteUrl: "https://platform.deepseek.com",
    category: "cn_official"
  },
  {
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go",
    model: "deepseek-v4-flash[1M]",
    websiteUrl: "https://opencode.ai/go",
    apiKeyUrl: "https://opencode.ai/go",
    category: "third_party"
  },
  {
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen",
    model: "claude-sonnet-5-5",
    websiteUrl: "https://opencode.ai/zen",
    apiKeyUrl: "https://opencode.ai/auth",
    category: "aggregator"
  },
  {
    name: "Tencent Token Plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/anthropic",
    model: "tc-code-latest",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Pro",
    baseUrl: "https://tokenhub.tencentmaas.com/plan/anthropic",
    model: "auto",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Pro (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Lite",
    baseUrl: "https://tokenhub.tencentmaas.com/plan/anthropic",
    model: "auto",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Lite (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-5.3[1M]",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    category: "cn_official"
  },
  {
    name: "Zhipu GLM en",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: "glm-5.3[1M]",
    websiteUrl: "https://z.ai",
    apiKeyUrl: "https://z.ai/subscribe",
    category: "cn_official"
  },
  {
    name: "Baidu Qianfan Coding Plan",
    baseUrl: "https://qianfan.baidubce.com/anthropic/coding",
    model: "qianfan-code-latest",
    websiteUrl: "https://cloud.baidu.com/product/qianfan_modelbuilder",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    category: "cn_official"
  },
  {
    name: "Baidu Qianfan Token Plan",
    baseUrl: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
    model: "deepseek-v4-pro[1M]",
    websiteUrl: "https://cloud.baidu.com/product/codingplan.html",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/resource/token-plan",
    category: "cn_official"
  },
  {
    name: "千问AI平台",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max[1M]",
    websiteUrl: "https://platform.qianwenai.com/",
    apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    category: "cn_official"
  },
  {
    name: "千问AI平台 Coding Plan",
    baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    websiteUrl: "https://bailian.console.aliyun.com",
    category: "cn_official"
  },
  {
    name: "千问AI平台 Token Plan",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max[1M]",
    websiteUrl: "https://platform.qianwenai.com/pricing/token-plan",
    apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud",
    baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max[1M]",
    websiteUrl: "https://home.qwencloud.com/",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud For Coding",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.7-plus[1M]",
    websiteUrl: "https://www.qwencloud.com",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud Token Plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max[1M]",
    websiteUrl: "https://www.qwencloud.com/pricing/token-plan",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "StepFun",
    baseUrl: "https://api.stepfun.com/step_plan",
    model: "step-3.5-flash-2603",
    websiteUrl: "https://platform.stepfun.com/step-plan",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
    category: "cn_official"
  },
  {
    name: "StepFun en",
    baseUrl: "https://api.stepfun.ai/step_plan",
    model: "step-3.5-flash-2603",
    websiteUrl: "https://platform.stepfun.ai/step-plan",
    apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    category: "cn_official"
  },
  {
    name: "ModelScope",
    baseUrl: "https://api-inference.modelscope.cn",
    model: "ZhipuAI/GLM-5.2[1M]",
    websiteUrl: "https://modelscope.cn",
    category: "aggregator"
  },
  {
    name: "StreamLake",
    baseUrl: "https://wanqing.streamlakeapi.com/api/gateway/v1/endpoints/kat-coder-pro-v2.5/claude-code-proxy",
    model: "kat-coder-pro-v2.5",
    websiteUrl: "https://www.streamlake.com",
    apiKeyUrl: "https://console.streamlake.com/console/wanqing/api-key",
    category: "cn_official"
  },
  {
    name: "StreamLake en",
    baseUrl: "https://vanchin.streamlake.ai/api/gateway/v1/endpoints/kat-coder-pro-v2.5/claude-code-proxy",
    model: "kat-coder-pro-v2.5",
    websiteUrl: "https://console.streamlake.ai",
    apiKeyUrl: "https://console.streamlake.ai/console/api-key",
    category: "cn_official"
  },
  {
    name: "Longcat",
    baseUrl: "https://api.longcat.chat/anthropic",
    model: "LongCat-2.0[1M]",
    websiteUrl: "https://longcat.chat/platform",
    apiKeyUrl: "https://longcat.chat/platform/api_keys",
    category: "cn_official"
  },
  {
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/anthropic",
    model: "MiniMax-M3.1-Flash[1M]",
    websiteUrl: "https://platform.minimax.cn",
    apiKeyUrl: "https://platform.minimax.cn/subscribe/token-plan",
    category: "cn_official"
  },
  {
    name: "MiniMax en",
    baseUrl: "https://api.minimax.io/anthropic",
    model: "MiniMax-M3.1-Flash[1M]",
    websiteUrl: "https://platform.minimax.io",
    apiKeyUrl: "https://platform.minimax.io/subscribe/coding-plan",
    category: "cn_official"
  },
  {
    name: "BaiLing",
    baseUrl: "https://api.ant-ling.com/anthropic",
    model: "Ling-2.6-1T",
    websiteUrl: "https://developer.ant-ling.com/zh-CN/docs/",
    apiKeyUrl: "https://chat.ant-ling.com/open",
    category: "cn_official"
  },
  {
    name: "AiHubMix",
    baseUrl: "https://aihubmix.com",
    websiteUrl: "https://aihubmix.com",
    apiKeyUrl: "https://aihubmix.com",
    category: "aggregator"
  },
  {
    name: "CherryIN",
    baseUrl: "https://open.cherryin.net",
    model: "anthropic/claude-sonnet-5",
    websiteUrl: "https://open.cherryin.ai",
    apiKeyUrl: "https://open.cherryin.ai/console/token",
    category: "aggregator"
  },
  {
    name: "RelaxyCode",
    baseUrl: "https://www.relaxycode.com",
    websiteUrl: "https://www.relaxycode.com",
    apiKeyUrl: "https://www.relaxycode.com/register",
    category: "third_party"
  },
  {
    name: "E-FlowCode",
    baseUrl: "https://e-flowcode.cc",
    websiteUrl: "https://e-flowcode.cc",
    apiKeyUrl: "https://e-flowcode.cc",
    category: "third_party"
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "anthropic/claude-sonnet-5",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    category: "aggregator"
  },
  {
    name: "TheRouter",
    baseUrl: "https://api.therouter.ai",
    model: "anthropic/claude-sonnet-5",
    websiteUrl: "https://therouter.ai",
    apiKeyUrl: "https://dashboard.therouter.ai",
    category: "aggregator"
  },
  {
    name: "Baseten",
    baseUrl: "https://inference.baseten.co",
    model: "zai-org/GLM-5.3[1M]",
    websiteUrl: "https://www.baseten.co",
    apiKeyUrl: "https://app.baseten.co/settings/api_keys",
    category: "aggregator"
  },
  {
    name: "Novita AI",
    baseUrl: "https://api.novita.ai/anthropic",
    model: "zai-org/glm-5.1",
    websiteUrl: "https://novita.ai",
    apiKeyUrl: "https://novita.ai",
    category: "aggregator"
  },
  {
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com",
    model: "glm-5.3[1M]",
    websiteUrl: "https://ollama.com",
    apiKeyUrl: "https://ollama.com/settings/keys",
    category: "cloud_provider"
  },
  {
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen3.5",
    websiteUrl: "https://ollama.com",
    category: "local"
  },
  {
    name: "LM Studio",
    baseUrl: "http://localhost:1234",
    model: "openai/gpt-oss-20b",
    websiteUrl: "https://lmstudio.ai",
    category: "local"
  },
  {
    name: "llama.cpp",
    baseUrl: "http://127.0.0.1:9931",
    model: "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF",
    websiteUrl: "https://github.com/ggml-org/llama.cpp",
    category: "local"
  },
  {
    name: "vLLM",
    baseUrl: "http://localhost:8000",
    model: "Qwen/Qwen3.6-27B",
    websiteUrl: "https://vllm.ai",
    category: "local"
  },
  {
    name: "Meta Model API",
    baseUrl: "https://api.meta.ai",
    model: "muse-wonder-1.0[1M]",
    websiteUrl: "https://dev.meta.ai",
    apiKeyUrl: "https://dev.meta.ai",
    category: "cn_official"
  },
  {
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/anthropic",
    model: "deepseek-ai/DeepSeek-V4-Flash-0731[1M]",
    websiteUrl: "https://deepinfra.com",
    apiKeyUrl: "https://deepinfra.com/dash/api_keys",
    category: "aggregator"
  },
  {
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/claude-code",
    model: "anthropic/claude-sonnet-5.5",
    websiteUrl: "https://vercel.com/ai-gateway",
    apiKeyUrl: "https://vercel.com/d",
    category: "aggregator"
  },
  {
    name: "Nebius Token Factory",
    baseUrl: "https://api.tokenfactory.nebius.com",
    model: "zai-org/GLM-5.3[1M]",
    websiteUrl: "https://nebius.com/token-factory",
    apiKeyUrl: "https://tokenfactory.nebius.com/project/api-keys",
    category: "aggregator"
  },
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    websiteUrl: "https://groq.com",
    apiKeyUrl: "https://console.groq.com/keys",
    category: "aggregator"
  },
  {
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai",
    model: "MiniMax-M3[1M]",
    websiteUrl: "https://sambanova.ai",
    apiKeyUrl: "https://cloud.sambanova.ai/apis",
    category: "cloud_provider"
  },
  {
    name: "DigitalOcean",
    baseUrl: "https://inference.do-ai.run",
    websiteUrl: "https://www.digitalocean.com/products/ai-platform",
    apiKeyUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
    category: "cloud_provider"
  },
  {
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co",
    model: "zai-org/GLM-5.3:baseten[1M]",
    websiteUrl: "https://huggingface.co/inference/models",
    apiKeyUrl: "https://huggingface.co/settings/tokens/new",
    category: "aggregator"
  },
  {
    name: "Microsoft Foundry",
    baseUrl: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic",
    model: "claude-opus-5-5",
    websiteUrl: "https://azure.microsoft.com/en-us/products/ai-foundry",
    apiKeyUrl: "https://ai.azure.com/",
    category: "cloud_provider"
  },
  {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference",
    model: "accounts/fireworks/models/glm-5p3[1M]",
    websiteUrl: "https://fireworks.ai",
    apiKeyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    category: "cloud_provider"
  },
  {
    name: "Cloudflare AI Gateway",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/anthropic",
    model: "claude-sonnet-5-5",
    websiteUrl: "https://developers.cloudflare.com/ai-gateway/",
    apiKeyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    category: "cloud_provider"
  },
  {
    name: "Nvidia",
    baseUrl: "https://integrate.api.nvidia.com",
    model: "moonshotai/kimi-k3[1M]",
    websiteUrl: "https://build.nvidia.com",
    apiKeyUrl: "https://build.nvidia.com/settings/api-keys",
    category: "aggregator"
  },
  {
    name: "PIPELLM",
    baseUrl: "https://cc-api.pipellm.ai",
    model: "claude-opus-5",
    websiteUrl: "https://code.pipellm.ai",
    apiKeyUrl: "https://code.pipellm.ai/login",
    category: "aggregator"
  },
  {
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    model: "mimo-v2.6-pro[1M]",
    websiteUrl: "https://platform.xiaomimimo.com",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    category: "cn_official"
  },
  {
    name: "Xiaomi MiMo Token Plan (China)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    model: "mimo-v2.6-pro[1M]",
    websiteUrl: "https://platform.xiaomimimo.com/#/token-plan",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
    category: "cn_official"
  },
  {
    name: "AWS Bedrock (AKSK)",
    baseUrl: "https://bedrock-runtime.${AWS_REGION}.amazonaws.com",
    model: "global.anthropic.claude-opus-5",
    websiteUrl: "https://aws.amazon.com/bedrock/",
    category: "cloud_provider"
  },
  {
    name: "AWS Bedrock (API Key)",
    baseUrl: "https://bedrock-runtime.${AWS_REGION}.amazonaws.com",
    model: "global.anthropic.claude-opus-5",
    websiteUrl: "https://aws.amazon.com/bedrock/",
    category: "cloud_provider"
  },
  {
    name: "JieKou AI",
    baseUrl: "https://api.jiekou.ai/anthropic",
    model: "claude-fable-5",
    websiteUrl: "https://jiekou.ai/#model-library",
    apiKeyUrl: "https://jiekou.ai/settings/key-management",
    category: "aggregator"
  },
  {
    name: "AICodeWith",
    baseUrl: "https://api.aicodewith.ai",
    websiteUrl: "https://aicodewith.ai",
    apiKeyUrl: "https://aicodewith.ai/login",
    category: "aggregator"
  },
  {
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider",
    model: "deepseek/deepseek-v4.1-flash[1M]",
    websiteUrl: "https://commandcode.ai",
    apiKeyUrl: "https://commandcode.ai/settings/keys",
    category: "third_party"
  },
  {
    name: "模力方舟",
    baseUrl: "https://moark.com/anthropic",
    model: "deepseek-v4-flash-0731[1M]",
    websiteUrl: "https://moark.com",
    apiKeyUrl: "https://moark.com/dashboard/tokens",
    category: "aggregator"
  },
  {
    name: "SoruxGPT",
    baseUrl: "https://ai.soruxgpt.com",
    websiteUrl: "https://ai.soruxgpt.com",
    apiKeyUrl: "https://ai.soruxgpt.com/console/token",
    category: "aggregator"
  },
  {
    name: "SoruxGPT Coding Plan",
    baseUrl: "https://app.soruxgpt.com/api/cc",
    websiteUrl: "https://app.soruxgpt.com",
    category: "aggregator"
  },
  {
    name: "IKunCode",
    baseUrl: "https://api.ikuncode.ai",
    websiteUrl: "https://api.ikuncode.ai",
    apiKeyUrl: "https://api.ikuncode.ai/console/token",
    category: "aggregator"
  },
  {
    name: "RunToken",
    baseUrl: "https://www.runtoken.ai",
    websiteUrl: "https://www.runtoken.ai",
    apiKeyUrl: "https://www.runtoken.ai/console/token",
    category: "aggregator"
  },
  {
    name: "BotCF",
    baseUrl: "https://botcf.com",
    websiteUrl: "https://botcf.com",
    apiKeyUrl: "https://botcf.com/console/token",
    category: "aggregator"
  },
  {
    name: "YYLX",
    baseUrl: "https://app.yylx.io",
    websiteUrl: "https://yylx.io",
    apiKeyUrl: "https://app.yylx.io/keys",
    category: "aggregator"
  },
  {
    name: "TokenFlux",
    baseUrl: "https://tokenflux.dev",
    websiteUrl: "https://tokenflux.dev",
    apiKeyUrl: "https://tokenflux.dev/keys",
    category: "aggregator"
  },
  {
    name: "NekoCode",
    baseUrl: "https://nekoapi.ai",
    websiteUrl: "https://nekoapi.ai",
    apiKeyUrl: "https://nekoapi.ai/token",
    category: "aggregator"
  },
  {
    name: "AIComing",
    baseUrl: "https://api.aicoming.top",
    websiteUrl: "https://aicoming.top",
    apiKeyUrl: "https://aicoming.top/console#keys",
    category: "aggregator"
  }
];

export const codexProviderPresets: ProviderPresetEntry[] = [
  {
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
    websiteUrl: "https://platform.kimi.com",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    category: "cn_official"
  },
  {
    name: "Kimi Global",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k3",
    websiteUrl: "https://platform.kimi.ai",
    apiKeyUrl: "https://platform.kimi.ai/console/api-keys",
    category: "cn_official"
  },
  {
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    websiteUrl: "https://www.kimi.com/code/",
    apiKeyUrl: "https://www.kimi.com/code/",
    category: "cn_official"
  },
  {
    name: "Kimi For Coding Global",
    baseUrl: "https://api.kimi.ai/coding/v1",
    model: "kimi-for-coding",
    websiteUrl: "https://www.kimi.ai/code",
    apiKeyUrl: "https://www.kimi.ai/code",
    category: "cn_official"
  },
  {
    name: "PackyCode",
    baseUrl: "https://www.packyapi.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.packyapi.ai",
    apiKeyUrl: "https://www.packyapi.ai/register",
    category: "third_party"
  },
  {
    name: "ZetaAPI",
    baseUrl: "https://api.zetaapi.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://zetaapi.ai",
    apiKeyUrl: "https://zetaapi.ai/go/u117",
    category: "aggregator"
  },
  {
    name: "APINebula",
    baseUrl: "https://apinebula.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://apinebula.ai",
    apiKeyUrl: "https://apinebula.ai/VjM74M",
    category: "third_party"
  },
  {
    name: "AICodeMirror",
    baseUrl: "https://api.aicodemirror.ai/api/codex/backend-api/codex",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.aicodemirror.ai",
    apiKeyUrl: "https://www.aicodemirror.ai/register",
    category: "thirdparty"
  },
  {
    name: "PatewayAI",
    baseUrl: "https://api.pateway.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://pateway.ai",
    apiKeyUrl: "https://pateway.ai/",
    category: "third_party"
  },
  {
    name: "FennoAI",
    baseUrl: "https://api.fenno.ai",
    model: "gpt-5.6-sol",
    websiteUrl: "https://api.fenno.ai",
    apiKeyUrl: "https://api.fenno.ai/register",
    category: "aggregator"
  },
  {
    name: "RunAPI",
    baseUrl: "https://runapi.host/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://runapi.host",
    apiKeyUrl: "https://runapi.host/register",
    category: "aggregator"
  },
  {
    name: "OpenModel",
    baseUrl: "https://api.openmodel.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.openmodel.ai",
    apiKeyUrl: "https://www.openmodel.ai",
    category: "aggregator"
  },
  {
    name: "GrooRoute Pro",
    baseUrl: "https://grooroute.pro/v1",
    model: "gpt-6-sol",
    websiteUrl: "https://grooroute.pro",
    apiKeyUrl: "https://grooroute.pro/sign-up",
    category: "aggregator"
  },
  {
    name: "TokenFactory",
    baseUrl: "https://api.tokenfactory.cn/v1",
    model: "glm-5.3",
    websiteUrl: "https://tokenfactory.cn",
    apiKeyUrl: "https://console.tokenfactory.cn/login",
    category: "aggregator"
  },
  {
    name: "Shengsuanyun",
    baseUrl: "https://router.shengsuanyun.com/api/v1",
    model: "openai/gpt-5.6-sol",
    websiteUrl: "https://www.shengsuanyun.com/",
    apiKeyUrl: "https://www.shengsuanyun.com/",
    category: "aggregator"
  },
  {
    name: "AIGoCode",
    baseUrl: "https://api.aigocode.dev",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aigocode.net",
    apiKeyUrl: "https://aigocode.net/invite/CC-SWITCH",
    category: "third_party"
  },
  {
    name: "Qiniu",
    baseUrl: "https://api.qnaigc.com/bypass/openai/v1",
    model: "gpt-6-astra",
    websiteUrl: "https://s.qiniu.com/nMvAvy",
    apiKeyUrl: "https://s.qiniu.com/nMvAvy",
    category: "aggregator"
  },
  {
    name: "AICoding",
    baseUrl: "https://api.aicoding.inc",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aicoding.inc",
    apiKeyUrl: "https://aicoding.inc/i/CCSWITCH",
    category: "thirdparty"
  },
  {
    name: "SubRouter",
    baseUrl: "https://subrouter.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://subrouter.ai",
    apiKeyUrl: "https://subrouter.ai/register",
    category: "aggregator"
  },
  {
    name: "FluxA Token Plan",
    baseUrl: "https://api.baiduqianfan.ai/v2/tokenplan/team",
    model: "deepseek-v4-pro",
    websiteUrl: "https://agentmarket.fluxapay.xyz/",
    apiKeyUrl: "https://agentmarket.fluxapay.xyz/marketplace/tokenplans",
    category: "aggregator"
  },
  {
    name: "88API",
    baseUrl: "https://api.88api.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://88api.ai",
    apiKeyUrl: "https://88api.ai/sign-up",
    category: "aggregator"
  },
  {
    name: "APIKEY.FUN",
    baseUrl: "https://api.apikey.fan/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://apikey.fan",
    apiKeyUrl: "https://apikey.fan/register",
    category: "third_party"
  },
  {
    name: "9527CODE",
    baseUrl: "https://9527.codes/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://9527.codes",
    apiKeyUrl: "https://9527.codes/register",
    category: "aggregator"
  },
  {
    name: "Code0",
    baseUrl: "https://code0.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://code0.ai",
    apiKeyUrl: "https://code0.ai/agent/register/B2XHxGjGmRvqgznY",
    category: "aggregator"
  },
  {
    name: "TeamoRouter",
    baseUrl: "https://api.teamorouter.cn/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://teamorouter.cn",
    apiKeyUrl: "https://teamorouter.cn/",
    category: "aggregator"
  },
  {
    name: "PPIO",
    baseUrl: "https://api.ppio.com/openai/v1",
    model: "deepseek/deepseek-v4-flash-0731",
    websiteUrl: "https://ppio.com",
    apiKeyUrl: "https://ppio.com/activity/ccswitch",
    category: "aggregator"
  },
  {
    name: "ClaudeCN",
    baseUrl: "https://claudecn.top/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://claudecn.top",
    apiKeyUrl: "https://claudecn.ai/register",
    category: "third_party"
  },
  {
    name: "火山 Agent Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "ark-code-latest",
    websiteUrl: "https://www.volcengine.com/activity/agentplan",
    apiKeyUrl: "https://www.volcengine.com/activity/agentplan",
    category: "cn_official"
  },
  {
    name: "火山 Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "ark-code-latest",
    websiteUrl: "https://www.volcengine.com/activity/codingplan",
    apiKeyUrl: "https://www.volcengine.com/activity/codingplan",
    category: "cn_official"
  },
  {
    name: "BytePlus",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    model: "ark-code-latest",
    websiteUrl: "https://www.byteplus.com/en/product/modelark",
    apiKeyUrl: "https://www.byteplus.com/en/product/modelark",
    category: "cn_official"
  },
  {
    name: "Volcengine Doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-pro-260628",
    websiteUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    category: "cn_official"
  },
  {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    websiteUrl: "https://siliconflow.cn",
    apiKeyUrl: "https://cloud.siliconflow.cn/i/YflgU2Ve",
    category: "aggregator"
  },
  {
    name: "SiliconFlow en",
    baseUrl: "https://api.siliconflow.com/v1",
    model: "MiniMaxAI/MiniMax-M3",
    websiteUrl: "https://siliconflow.com",
    apiKeyUrl: "https://cloud.siliconflow.cn/i/YflgU2Ve",
    category: "aggregator"
  },
  {
    name: "A6API",
    baseUrl: "https://api.a6api.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.a6api.com",
    apiKeyUrl: "https://a6api.com/register",
    category: "aggregator"
  },
  {
    name: "Compshare",
    baseUrl: "https://api.modelverse.cn/v1",
    model: "gpt-6-astra",
    websiteUrl: "https://www.compshare.cn",
    apiKeyUrl: "https://www.compshare.cn/coding-plan",
    category: "aggregator"
  },
  {
    name: "Compshare Coding Plan",
    baseUrl: "https://cp.compshare.cn/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.compshare.cn",
    apiKeyUrl: "https://www.compshare.cn/coding-plan",
    category: "aggregator"
  },
  {
    name: "CCSub",
    baseUrl: "https://www.ccsub.net/v1",
    model: "gpt-6-astra",
    websiteUrl: "https://www.ccsub.net",
    apiKeyUrl: "https://www.ccsub.net/register",
    category: "aggregator"
  },
  {
    name: "SSSAiCode",
    baseUrl: "https://node-hk.sssaicodeapi.com/api/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://sssaicodeapi.com",
    apiKeyUrl: "https://sssaicodeapi.com/register",
    category: "third_party"
  },
  {
    name: "SoleAPI",
    baseUrl: "https://soleapi.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://soleapi.com",
    apiKeyUrl: "https://soleapi.com/r/ccswitch",
    category: "aggregator"
  },
  {
    name: "Micu",
    baseUrl: "https://www.micuapi.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.micuapi.ai",
    apiKeyUrl: "https://www.micuapi.ai/register",
    category: "third_party"
  },
  {
    name: "RightCode",
    baseUrl: "https://www.rightapi.ai/codex/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.rightapi.ai",
    apiKeyUrl: "https://www.rightapi.ai/register",
    category: "third_party"
  },
  {
    name: "Cubence",
    baseUrl: "https://api.cubence.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://cubence.com",
    apiKeyUrl: "https://cubence.com/signup",
    category: "third_party"
  },
  {
    name: "CrazyRouter",
    baseUrl: "https://cn.crazyrouter.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.crazyrouter.com",
    apiKeyUrl: "https://www.crazyrouter.com/register",
    category: "thirdparty"
  },
  {
    name: "DMXAPI",
    baseUrl: "https://www.dmxapi.cn/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.dmxapi.cn",
    category: "aggregator"
  },
  {
    name: "SudoCode.chat",
    baseUrl: "https://api.sudocode.chat/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://sudocode.chat",
    apiKeyUrl: "https://sudocode.chat/sign-up",
    category: "third_party"
  },
  {
    name: "SudoCode.us",
    baseUrl: "https://sudocode.us/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://sudocode.us",
    apiKeyUrl: "https://sudocode.us",
    category: "third_party"
  },
  {
    name: "XycAi",
    baseUrl: "https://apicdn.xycai.us/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://xycai.us",
    apiKeyUrl: "https://xycai.us/register",
    category: "aggregator"
  },
  {
    name: "Modelflare",
    baseUrl: "https://modelflare.dev/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://modelflare.dev",
    apiKeyUrl: "https://modelflare.dev/sign-up",
    category: "aggregator"
  },
  {
    name: "EveryAPI",
    baseUrl: "https://api.everyapi.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://everyapi.ai",
    apiKeyUrl: "https://app.everyapi.ai/signin",
    category: "aggregator"
  },
  {
    name: "AllTokens",
    baseUrl: "https://alltokens.cc/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://alltokens.cc",
    apiKeyUrl: "https://alltokens.cc/register",
    category: "aggregator"
  },
  {
    name: "AllTokens SI",
    baseUrl: "https://alltokens.si/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://alltokens.si",
    apiKeyUrl: "https://alltokens.si/enterprise-register",
    category: "aggregator"
  },
  {
    name: "Tu-zi",
    baseUrl: "https://api.tu-zi.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://api.tu-zi.com",
    apiKeyUrl: "https://api.tu-zi.com/token",
    category: "aggregator"
  },
  {
    name: "Amux",
    baseUrl: "https://api.amux.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://amux.ai",
    apiKeyUrl: "https://amux.ai",
    category: "aggregator"
  },
  {
    name: "AtlasCloud",
    baseUrl: "https://api.atlascloud.ai/v1",
    model: "zai-org/glm-5.2",
    websiteUrl: "https://www.atlascloud.ai/console/coding-plan",
    apiKeyUrl: "https://www.atlascloud.ai/console/coding-plan",
    category: "aggregator"
  },
  {
    name: "Soshow",
    baseUrl: "https://maas.so-show.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aimarket.so-show.com",
    apiKeyUrl: "https://aimarket.so-show.com/workbench/access-key",
    category: "aggregator"
  },
  {
    name: "Azure OpenAI",
    baseUrl: "https://YOUR_RESOURCE_NAME.openai.azure.com/openai",
    model: "gpt-5.6-sol",
    websiteUrl: "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/codex",
    category: "third_party"
  },
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    category: "cn_official"
  },
  {
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/v1",
    model: "glm-5.3",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    category: "cn_official"
  },
  {
    name: "Zhipu GLM en",
    baseUrl: "https://api.z.ai/api/v1",
    model: "glm-5.3",
    websiteUrl: "https://z.ai",
    apiKeyUrl: "https://z.ai/subscribe",
    category: "cn_official"
  },
  {
    name: "Baidu Qianfan",
    baseUrl: "https://qianfan.baidubce.com/v2",
    model: "deepseek-v4-pro",
    websiteUrl: "https://cloud.baidu.com/product/qianfan_modelbuilder",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    category: "cn_official"
  },
  {
    name: "Baidu Qianfan Coding Plan",
    baseUrl: "https://qianfan.baidubce.com/v2/coding",
    model: "qianfan-code-latest",
    websiteUrl: "https://cloud.baidu.com/product/qianfan_modelbuilder",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    category: "cn_official"
  },
  {
    name: "Baidu Qianfan Token Plan",
    baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal",
    model: "deepseek-v4-pro",
    websiteUrl: "https://cloud.baidu.com/product/codingplan.html",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/resource/token-plan",
    category: "cn_official"
  },
  {
    name: "千问AI平台",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    websiteUrl: "https://platform.qianwenai.com/",
    apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    category: "cn_official"
  },
  {
    name: "千问AI平台 Token Plan",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    websiteUrl: "https://platform.qianwenai.com/pricing/token-plan",
    apiKeyUrl: "https://platform.qianwenai.com/home/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    websiteUrl: "https://home.qwencloud.com/",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud For Coding",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    model: "qwen3.7-plus",
    websiteUrl: "https://www.qwencloud.com",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "QwenCloud Token Plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max",
    websiteUrl: "https://www.qwencloud.com/pricing/token-plan",
    apiKeyUrl: "https://home.qwencloud.com/api-keys",
    category: "cn_official"
  },
  {
    name: "Tencent Hunyuan",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    model: "hy3",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/apikey",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    model: "tc-code-latest",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Pro",
    baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
    model: "auto",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Pro (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Lite",
    baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
    model: "auto",
    websiteUrl: "https://cloud.tencent.com/product/tokenhub",
    apiKeyUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "Tencent Token Plan Enterprise Lite (Intl)",
    baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/plan/v3",
    model: "auto",
    websiteUrl: "https://www.tencentcloud.com/products/tokenhub",
    apiKeyUrl: "https://console.tencentcloud.com/tokenhub/tokenplan-e",
    category: "cn_official"
  },
  {
    name: "StepFun API",
    baseUrl: "https://api.stepfun.com/v1",
    model: "step-3.7-flash",
    websiteUrl: "https://platform.stepfun.com",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
    category: "cn_official"
  },
  {
    name: "StepFun API en",
    baseUrl: "https://api.stepfun.ai/v1",
    model: "step-3.7-flash",
    websiteUrl: "https://platform.stepfun.ai",
    apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    category: "cn_official"
  },
  {
    name: "StepFun",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    model: "step-3.7-flash",
    websiteUrl: "https://platform.stepfun.com/step-plan",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
    category: "cn_official"
  },
  {
    name: "StepFun en",
    baseUrl: "https://api.stepfun.ai/step_plan/v1",
    model: "step-3.7-flash",
    websiteUrl: "https://platform.stepfun.ai/step-plan",
    apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    category: "cn_official"
  },
  {
    name: "ModelScope",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    model: "ZhipuAI/GLM-5.2",
    websiteUrl: "https://modelscope.cn",
    apiKeyUrl: "https://modelscope.cn/my/myaccesstoken",
    category: "aggregator"
  },
  {
    name: "StreamLake",
    baseUrl: "https://wanqing.streamlakeapi.com/api/gateway/v1/endpoints",
    model: "kat-coder-pro-v2.5",
    websiteUrl: "https://www.streamlake.com",
    apiKeyUrl: "https://console.streamlake.com/console/wanqing/api-key",
    category: "cn_official"
  },
  {
    name: "StreamLake en",
    baseUrl: "https://vanchin.streamlake.ai/api/gateway/v1/endpoints",
    model: "kat-coder-pro-v2.5",
    websiteUrl: "https://console.streamlake.ai",
    apiKeyUrl: "https://console.streamlake.ai/console/api-key",
    category: "cn_official"
  },
  {
    name: "Longcat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    model: "LongCat-2.0",
    websiteUrl: "https://longcat.chat/platform",
    apiKeyUrl: "https://longcat.chat/platform/api_keys",
    category: "cn_official"
  },
  {
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/v1",
    model: "MiniMax-M3.1-Flash",
    websiteUrl: "https://platform.minimax.cn",
    apiKeyUrl: "https://platform.minimax.cn/subscribe/token-plan",
    category: "cn_official"
  },
  {
    name: "MiniMax en",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3.1-Flash",
    websiteUrl: "https://platform.minimax.io",
    apiKeyUrl: "https://platform.minimax.io/subscribe/coding-plan",
    category: "cn_official"
  },
  {
    name: "Astron Coding Plan",
    baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1",
    model: "astron-code-latest",
    websiteUrl: "https://maas.xfyun.cn/packageSubscription",
    apiKeyUrl: "https://maas.xfyun.cn/packageSubscription",
    category: "cn_official"
  },
  {
    name: "BaiLing",
    baseUrl: "https://api.ant-ling.com/v1",
    model: "Ling-2.6-1T",
    websiteUrl: "https://developer.ant-ling.com/zh-CN/docs/",
    apiKeyUrl: "https://chat.ant-ling.com/open",
    category: "cn_official"
  },
  {
    name: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-pro",
    websiteUrl: "https://platform.xiaomimimo.com",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    category: "cn_official"
  },
  {
    name: "Xiaomi MiMo Token Plan (China)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.6-pro",
    websiteUrl: "https://platform.xiaomimimo.com/#/token-plan",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
    category: "cn_official"
  },
  {
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    model: "zai-org/GLM-5.3",
    websiteUrl: "https://www.baseten.co",
    apiKeyUrl: "https://app.baseten.co/settings/api_keys",
    category: "aggregator"
  },
  {
    name: "Novita AI",
    baseUrl: "https://api.novita.ai/openai/v1",
    model: "zai-org/glm-5.3",
    websiteUrl: "https://novita.ai",
    apiKeyUrl: "https://novita.ai",
    category: "aggregator"
  },
  {
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.5",
    websiteUrl: "https://x.ai/api",
    apiKeyUrl: "https://console.x.ai",
    category: "third_party"
  },
  {
    name: "Nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "moonshotai/kimi-k3",
    websiteUrl: "https://build.nvidia.com",
    apiKeyUrl: "https://build.nvidia.com/settings/api-keys",
    category: "aggregator"
  },
  {
    name: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    model: "glm-5.3",
    websiteUrl: "https://ollama.com",
    apiKeyUrl: "https://ollama.com/settings/keys",
    category: "cloud_provider"
  },
  {
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "gpt-oss:20b",
    websiteUrl: "https://ollama.com",
    category: "local"
  },
  {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "openai/gpt-oss-20b",
    websiteUrl: "https://lmstudio.ai",
    category: "local"
  },
  {
    name: "llama.cpp",
    baseUrl: "http://127.0.0.1:9931/v1",
    model: "ggml-org/Qwen3-Coder-30B-A3B-Instruct-Q8_0-GGUF",
    websiteUrl: "https://github.com/ggml-org/llama.cpp",
    category: "local"
  },
  {
    name: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    model: "Qwen/Qwen3.6-27B",
    websiteUrl: "https://vllm.ai",
    category: "local"
  },
  {
    name: "Meta Model API",
    baseUrl: "https://api.meta.ai/v1",
    model: "muse-wonder-1.0",
    websiteUrl: "https://dev.meta.ai",
    apiKeyUrl: "https://dev.meta.ai",
    category: "cn_official"
  },
  {
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1",
    model: "deepseek-ai/DeepSeek-V4-Flash-0731",
    websiteUrl: "https://deepinfra.com",
    apiKeyUrl: "https://deepinfra.com/dash/api_keys",
    category: "aggregator"
  },
  {
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/codex/v1",
    model: "openai/gpt-6-astra",
    websiteUrl: "https://vercel.com/ai-gateway",
    apiKeyUrl: "https://vercel.com/d",
    category: "aggregator"
  },
  {
    name: "Nebius Token Factory",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    model: "zai-org/GLM-5.3",
    websiteUrl: "https://nebius.com/token-factory",
    apiKeyUrl: "https://tokenfactory.nebius.com/project/api-keys",
    category: "aggregator"
  },
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    websiteUrl: "https://groq.com",
    apiKeyUrl: "https://console.groq.com/keys",
    category: "aggregator"
  },
  {
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    model: "MiniMax-M3",
    websiteUrl: "https://sambanova.ai",
    apiKeyUrl: "https://cloud.sambanova.ai/apis",
    category: "cloud_provider"
  },
  {
    name: "DigitalOcean",
    baseUrl: "https://inference.do-ai.run/v1",
    model: "openai-gpt-6-1-sol",
    websiteUrl: "https://www.digitalocean.com/products/ai-platform",
    apiKeyUrl: "https://cloud.digitalocean.com/model-studio/manage-keys",
    category: "cloud_provider"
  },
  {
    name: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    model: "zai-org/GLM-5.3:baseten",
    websiteUrl: "https://huggingface.co/inference/models",
    apiKeyUrl: "https://huggingface.co/settings/tokens/new",
    category: "aggregator"
  },
  {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/glm-5p3",
    websiteUrl: "https://fireworks.ai",
    apiKeyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    category: "cloud_provider"
  },
  {
    name: "Cloudflare AI Gateway",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/default/openai",
    model: "gpt-6.1-sol",
    websiteUrl: "https://developers.cloudflare.com/ai-gateway/",
    apiKeyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    category: "cloud_provider"
  },
  {
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "glm-5.3",
    websiteUrl: "https://opencode.ai/go",
    apiKeyUrl: "https://opencode.ai/go",
    category: "third_party"
  },
  {
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    model: "gpt-6-sol",
    websiteUrl: "https://opencode.ai/zen",
    apiKeyUrl: "https://opencode.ai/auth",
    category: "aggregator"
  },
  {
    name: "AiHubMix",
    baseUrl: "https://aihubmix.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aihubmix.com",
    category: "aggregator"
  },
  {
    name: "CherryIN",
    baseUrl: "https://open.cherryin.net/v1",
    model: "openai/gpt-5.6-sol",
    websiteUrl: "https://open.cherryin.ai",
    apiKeyUrl: "https://open.cherryin.ai/console/token",
    category: "aggregator"
  },
  {
    name: "RelaxyCode",
    baseUrl: "https://www.relaxycode.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.relaxycode.com",
    apiKeyUrl: "https://www.relaxycode.com/register",
    category: "third_party"
  },
  {
    name: "E-FlowCode",
    baseUrl: "https://e-flowcode.cc/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://e-flowcode.cc",
    apiKeyUrl: "https://e-flowcode.cc",
    category: "third_party"
  },
  {
    name: "PIPELLM",
    baseUrl: "https://cc-api.pipellm.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://code.pipellm.ai",
    apiKeyUrl: "https://code.pipellm.ai/login",
    category: "aggregator"
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    category: "aggregator"
  },
  {
    name: "TheRouter",
    baseUrl: "https://api.therouter.ai/v1",
    model: "openai/gpt-5.3-codex",
    websiteUrl: "https://therouter.ai",
    apiKeyUrl: "https://dashboard.therouter.ai",
    category: "aggregator"
  },
  {
    name: "JieKou AI",
    baseUrl: "https://api.jiekou.ai/openai/v1",
    model: "claude-fable-5",
    websiteUrl: "https://jiekou.ai/#model-library",
    apiKeyUrl: "https://jiekou.ai/settings/key-management",
    category: "aggregator"
  },
  {
    name: "AICodeWith",
    baseUrl: "https://api.aicodewith.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aicodewith.ai",
    apiKeyUrl: "https://aicodewith.ai/login",
    category: "aggregator"
  },
  {
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    model: "deepseek/deepseek-v4.1-flash",
    websiteUrl: "https://commandcode.ai",
    apiKeyUrl: "https://commandcode.ai/settings/keys",
    category: "third_party"
  },
  {
    name: "模力方舟",
    baseUrl: "https://moark.com/v1",
    model: "deepseek-v4-flash-0731",
    websiteUrl: "https://moark.com",
    apiKeyUrl: "https://moark.com/dashboard/tokens",
    category: "aggregator"
  },
  {
    name: "SoruxGPT",
    baseUrl: "https://ai.soruxgpt.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://ai.soruxgpt.com",
    apiKeyUrl: "https://ai.soruxgpt.com/console/token",
    category: "aggregator"
  },
  {
    name: "SoruxGPT Coding Plan",
    baseUrl: "https://app.soruxgpt.com/api/codex",
    model: "gpt-5.6-sol",
    websiteUrl: "https://app.soruxgpt.com",
    category: "aggregator"
  },
  {
    name: "IKunCode",
    baseUrl: "https://api.ikuncode.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://api.ikuncode.ai",
    apiKeyUrl: "https://api.ikuncode.ai/console/token",
    category: "aggregator"
  },
  {
    name: "RunToken",
    baseUrl: "https://www.runtoken.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://www.runtoken.ai",
    apiKeyUrl: "https://www.runtoken.ai/console/token",
    category: "aggregator"
  },
  {
    name: "BotCF",
    baseUrl: "https://botcf.com/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://botcf.com",
    apiKeyUrl: "https://botcf.com/console/token",
    category: "aggregator"
  },
  {
    name: "YYLX",
    baseUrl: "https://app.yylx.io/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://yylx.io",
    apiKeyUrl: "https://app.yylx.io/keys",
    category: "aggregator"
  },
  {
    name: "TokenFlux",
    baseUrl: "https://tokenflux.dev/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://tokenflux.dev",
    apiKeyUrl: "https://tokenflux.dev/keys",
    category: "aggregator"
  },
  {
    name: "NekoCode",
    baseUrl: "https://nekoapi.ai/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://nekoapi.ai",
    apiKeyUrl: "https://nekoapi.ai/token",
    category: "aggregator"
  },
  {
    name: "AIComing",
    baseUrl: "https://api.aicoming.top/v1",
    model: "gpt-5.6-sol",
    websiteUrl: "https://aicoming.top",
    apiKeyUrl: "https://aicoming.top/console#keys",
    category: "aggregator"
  }
];
