// 会话令牌的「片段级」出站匹配与脱敏（纯函数层，bridge 与 VM 夹具共用）。
//
// 背景：二代提示词鼓励模型把长内容拆条发送；旧出站审计只做整串 includes，
// 令牌被拆成两条就完全绕过（每条都不含完整令牌）。片段匹配 = 对每个已知
// token 预生成全部 N 字符滑窗；出站文本的任意 N 字符窗口命中即判定泄露。
//
// 灵敏度边界（有意为之）：拆分点落在窗口内部（两侧残留都 < N 字符）时检测
// 不到——N 越小越灵敏，但误伤普通文本的概率越高。N=12 对随机令牌的误伤率
// 可忽略，又要求拆条后每侧至少剩 12 个连续字符才能漏网。
// 短于 N 的 token 不参与片段匹配，只保留整串匹配（防误伤）。

export const TOKEN_FRAGMENT_LENGTH = 12;

export function createTokenFragmentMatcher({ fragmentLength = TOKEN_FRAGMENT_LENGTH } = {}) {
  const fragLen = Math.max(4, Math.round(Number(fragmentLength) || TOKEN_FRAGMENT_LENGTH));
  let fragments = new Set(); // 长度 == fragLen 的 token 滑窗集合
  let shortTokens = [];      // 不足 fragLen 的 token：只做整串匹配
  let allTokens = [];        // 全部 token：redact 的整串替换用（长 token 尾段 < fragLen，窗口扫盖不住）
  return {
    /** token 集合变化后重新预生成滑窗（O(令牌总长)）。 */
    sync(tokens) {
      fragments = new Set();
      shortTokens = [];
      allTokens = [];
      for (const item of tokens ?? []) {
        const t = String(item ?? '');
        if (!t) continue;
        allTokens.push(t);
        if (t.length < fragLen) {
          shortTokens.push(t);
          continue;
        }
        for (let i = 0; i + fragLen <= t.length; i += 1) fragments.add(t.slice(i, i + fragLen));
      }
    },
    /** 短 token 整串命中，或文本任意 N 字符滑窗命中 ⇒ true。 */
    test(text) {
      const s = String(text ?? '');
      if (!s) return false;
      for (const t of shortTokens) {
        if (s.includes(t)) return true;
      }
      if (s.length < fragLen) return false;
      for (let i = 0; i + fragLen <= s.length; i += 1) {
        if (fragments.has(s.slice(i, i + fragLen))) return true;
      }
      return false;
    },
    /** 整串命中的 token（不分长短）替换为 ***；滑窗命中的残段同样打码（残段也不能进日志）。 */
    redact(text) {
      let s = String(text ?? '');
      for (const t of allTokens) {
        if (t && s.includes(t)) s = s.split(t).join('***');
      }
      if (s.length < fragLen) return s;
      let out = '';
      let i = 0;
      while (i < s.length) {
        const win = s.slice(i, i + fragLen);
        if (win.length === fragLen && fragments.has(win)) {
          out += '***';
          i += fragLen; // 整窗打码并跳过，避免重叠窗口反复替换
        } else {
          out += s[i];
          i += 1;
        }
      }
      return out;
    }
  };
}
