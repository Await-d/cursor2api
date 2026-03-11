import { isTruncated } from "../dist/handler.js";
import { estimateTextTokens, estimateAnthropicInputTokens, estimateAnthropicOutputTokens, estimateOpenAICompletionTokens } from "../dist/token-estimator.js";

let passed = 0, failed = 0;

function test(name, fn) {
    try { fn(); console.log("  ✅  " + name); passed++; }
    catch (err) { console.log("  ❌  " + name + "\n     → " + err.message); failed++; }
}
function assertEqual(a,b,m){ if(a!==b) throw new Error(m??("Expected "+JSON.stringify(b)+" got "+JSON.stringify(a))); }
function assertTrue(v,m){ if(!v) throw new Error(m??("Expected truthy got "+JSON.stringify(v))); }
function assertFalse(v,m){ if(v) throw new Error(m??("Expected falsy got "+JSON.stringify(v))); }
function assertGte(a,min,m){ if(a<min) throw new Error(m??("Expected >="+min+" got "+a)); }
function assertRange(a,lo,hi,m){ if(a<lo||a>hi) throw new Error(m??("Expected "+lo+".."+hi+" got "+a)); }

console.log("\nð¦ [1] isTruncated — 代码块检测");
test("正常完整响应不截断", () => assertFalse(isTruncated("Here is the answer.\n\nDone.")));
test("空字符串不截断", () => assertFalse(isTruncated("")));
test("只有空白不截断", () => assertFalse(isTruncated("   \n  ")));
test("代码块未闭合截断", () => assertTrue(isTruncated("code:\n```javascript\nfunction foo() {"))); 
test("代码块完整闭合不截断", () => assertFalse(isTruncated("code:\n```js\nfoo()\n```")));
test("两个完整代码块不截断", () => assertFalse(isTruncated("A:\n```\nc1\n```\nB:\n```\nc2\n```")));
test("三个标记奇数截断", () => assertTrue(isTruncated("A:\n```\nc1\n```\nB:\n```\ncode")));

console.log("\nð¦ [2] isTruncated — 结尾符号");
test("逗号结尾截断", () => assertTrue(isTruncated("foo, bar,")));
test("冒号结尾截断", () => assertTrue(isTruncated("The result is:")));
test("开花括号结尾截断", () => assertTrue(isTruncated("function foo() {")));
test("开方括号结尾截断", () => assertTrue(isTruncated("const arr = [")));
test("开圆括号结尾截断", () => assertTrue(isTruncated("console.log(")));
test("句号结尾不截断", () => assertFalse(isTruncated("Done.")));
test("感叹号结尾不截断", () => assertFalse(isTruncated("Done!")));
test("问号结尾不截断", () => assertFalse(isTruncated("Is this correct?")));

console.log("\nð¦ [3] isTruncated — XML 标签");
test("XML完整闭合不截断", () => assertFalse(isTruncated("<result>\ncontent\n</result>")));
test("多个开标签截断", () => assertTrue(isTruncated("<root>\n<child>\n<nested>\ncontent")));
test("一开一闭平衡不截断", () => assertFalse(isTruncated("<result>\ncontent\n</result>\nmore")));
test("差1允许不截断", () => assertFalse(isTruncated("<result>\nno close tag")));

console.log("\nð¦ [4] estimateTextTokens");
test("空字符串返回1", () => assertEqual(estimateTextTokens(""), 1));
test("英文token合理", () => assertRange(estimateTextTokens("hello world"), 1, 6, ""));
test("中文权重高", () => { const cn=estimateTextTokens("你好世界"); const en=estimateTextTokens("abcd"); assertTrue(cn>=en, cn+">="+en); });
test("长文本增长", () => { const s=estimateTextTokens("hi"); const l=estimateTextTokens("hello world this is a longer sentence with more content"); assertTrue(l>s, l+">"+s); });
test("始终>=1", () => { assertGte(estimateTextTokens("x"),1); assertGte(estimateTextTokens(""),1); });

console.log("\nð¦ [5] estimateAnthropicInputTokens");
test("空消息>=1", () => assertGte(estimateAnthropicInputTokens({messages:[]}), 1));
test("单条消息合理", () => assertRange(estimateAnthropicInputTokens({messages:[{role:"user",content:"Hello, how are you?"}]}), 3, 15, ""));
test("系统提示词增加token", () => { const a=estimateAnthropicInputTokens({system:"You are helpful.",messages:[{role:"user",content:"Hi"}]}); const b=estimateAnthropicInputTokens({messages:[{role:"user",content:"Hi"}]}); assertTrue(a>b,a+">"+b); });
test("多轮对话递增", () => { const a=estimateAnthropicInputTokens({messages:[{role:"user",content:"Hello"}]}); const b=estimateAnthropicInputTokens({messages:[{role:"user",content:"Hello"},{role:"assistant",content:"Hi there how can I help?"}]}); assertTrue(b>a,b+">"+a); });
test("工具定义被计入", () => { const a=estimateAnthropicInputTokens({messages:[{role:"user",content:"Hi"}],tools:[{name:"Read",description:"Read a file",input_schema:{type:"object",properties:{path:{type:"string"}}}}]}); const b=estimateAnthropicInputTokens({messages:[{role:"user",content:"Hi"}]}); assertTrue(a>b,a+">"+b); });
test("数组与字符串系统提示词相同", () => { const a=estimateAnthropicInputTokens({system:[{type:"text",text:"You are helpful."}],messages:[{role:"user",content:"Hi"}]}); const b=estimateAnthropicInputTokens({system:"You are helpful.",messages:[{role:"user",content:"Hi"}]}); assertEqual(a,b,a+"=="+b); });

console.log("\nð¦ [6] estimateAnthropicOutputTokens");
test("空 blocks 返回1", () => assertEqual(estimateAnthropicOutputTokens([]), 1));
test("text block正常", () => assertRange(estimateAnthropicOutputTokens([{type:"text",text:"Hello world"}]), 1, 8, ""));
test("tool_use block", () => assertGte(estimateAnthropicOutputTokens([{type:"tool_use",id:"c1",name:"Read",input:{path:"/file.ts"}}]), 1));
test("多 blocks > 单个", () => { const s=estimateAnthropicOutputTokens([{type:"text",text:"Hello"}]); const m=estimateAnthropicOutputTokens([{type:"text",text:"Hello"},{type:"text",text:"world this is additional longer text content here"}]); assertTrue(m>s,m+">"+s); });
test("混合计算", () => assertGte(estimateAnthropicOutputTokens([{type:"text",text:"Using tool."},{type:"tool_use",id:"t1",name:"Bash",input:{command:"ls"}}]), 2));

console.log("\nð¦ [7] estimateOpenAICompletionTokens");
test("null content 返回1", () => assertEqual(estimateOpenAICompletionTokens(null), 1));
test("空字符串返回1", () => assertEqual(estimateOpenAICompletionTokens(""), 1));
test("普通文本合理", () => assertRange(estimateOpenAICompletionTokens("Hello, how are you doing today?"), 4, 15, ""));
test("带工具token更多", () => { const a=estimateOpenAICompletionTokens("OK"); const b=estimateOpenAICompletionTokens("OK",[{function:{arguments:JSON.stringify({path:"/test.ts",content:"some long content here to make it bigger"})}}]); assertTrue(b>a,b+">"+a); });
test("多工具调用累加", () => { const a=estimateOpenAICompletionTokens(null,[{function:{arguments:'{"path":"/a"}'}}]); const b=estimateOpenAICompletionTokens(null,[{function:{arguments:'{"path":"/a"}'}},{function:{arguments:'{"path":"/b","content":"hello world test"}'}}]); assertTrue(b>a,b+">"+a); });
test("空数组与无工具相同", () => { const a=estimateOpenAICompletionTokens("test",[]);  const b=estimateOpenAICompletionTokens("test"); assertEqual(a,b,a+"=="+b); });

const total = passed + failed;
console.log("\n" + "═".repeat(55));
console.log("  结果: " + passed + " 通过 / " + failed + " 失败 / " + total + " 总计");
console.log("═".repeat(55) + "\n");
if (failed > 0) process.exit(1);