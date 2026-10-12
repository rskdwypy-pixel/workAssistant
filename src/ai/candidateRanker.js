/**
 * 候选执行预筛
 *
 * 动机：把 50+ 个执行一次性丢给小模型（如 glm-4-flash），
 * 模型无法有效 discrimination —— 实测它会直接返回 executionId:0 放弃选择。
 * 同时 52 个候选还会显著抬高 token 成本。
 *
 * 做法：先用本地字符级相关度打分，把候选压缩到 Top-K 再交给 AI。
 * 这是「便宜的本地筛选 + 昂贵的模型决策」的标准分工：
 * 本地负责缩小范围，模型只需在少数几个里做区分。
 */

/**
 * 归一化文本（去标点、转小写）
 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_/\\|,.，。、;；:：!！?？()（）\[\]【】<>《》"'"'`~@#$%^&*+=|/\\]+/g, '');
}

/**
 * 生成字符二元组集合（中文无分词时，bigram 比整词匹配更稳）
 * @param {string} s 已归一化文本
 * @returns {Set<string>}
 */
function bigrams(s) {
  const set = new Set();
  if (!s) return set;
  if (s.length === 1) {
    set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/**
 * 计算文本相似度（bigram 重合度）
 * @returns {number} 0-1
 */
function similarity(a, b) {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (A.size === 0 || B.size === 0) return 0;

  let hit = 0;
  for (const g of A) {
    if (B.has(g)) hit++;
  }
  return hit / Math.min(A.size, B.size);
}

/**
 * 给候选执行打相关度分
 * @param {string} content - 用户输入
 * @param {Array} candidates - 候选执行
 * @returns {Array} [{ exec, score, matchedBy }]
 */
function scoreCandidates(content, candidates) {
  const input = normalize(content);

  return candidates.map(exec => {
    const name = exec.name || '';
    const project = exec.projectName || '';
    const aliases = exec.aliases || [];

    // 直接包含命中权重最高
    let score = 0;
    let matchedBy = '';

    const nName = normalize(name);
    const nProject = normalize(project);

    if (nName && input.includes(nName) && nName.length >= 2) {
      score = Math.max(score, 1);
      matchedBy = '执行名';
    }
    if (nProject && input.includes(nProject) && nProject.length >= 2) {
      score = Math.max(score, 0.95);
      matchedBy = matchedBy || '项目名';
    }

    for (const al of aliases) {
      const nAl = normalize(al);
      if (nAl && input.includes(nAl) && nAl.length >= 2) {
        score = Math.max(score, 0.9);
        matchedBy = matchedBy || '别名';
      }
    }

    if (score === 0) {
      // 退化：字符重合度。与名称+项目名的组合文本比较，
      // 避免「阿迪」这种简称与「阿迪达斯项目交付」因不相等而被漏掉。
      const s = Math.max(
        similarity(content, name),
        similarity(content, project),
        similarity(content, `${name}${project}`)
      );
      // 相似度本身弱，统一折扣，避免弱相关压过强相关
      score = s * 0.7;
      if (score > 0.01) matchedBy = '文本相似';
    }

    return { exec, score, matchedBy };
  });
}

/**
 * 收藏加权分
 *
 * 早期实现把「收藏 + 默认」硬置顶，实测出问题：用户收藏到 20+ 个时，
 * 它们会占满全部名额，反而把「当前这句话真正相关的执行」挤出去
 * （例如收藏里没有 149，但输入明确说「阿迪」，却被 22 个收藏挤掉）。
 * 改为：收藏只给一个固定加分（等同一次弱文本匹配），
 * 真正强相关的执行依然能凭更高文本分排到前面。
 */
const FAVORITE_BONUS = 0.15;

/**
 * 筛选并排序候选执行
 *
 * @param {string} content - 用户输入
 * @param {Array} candidates - 候选执行
 * @param {Object} options
 * @param {number} options.limit - 最多返回多少个，默认 12
 * @returns {Array} 排序后的候选（原对象，不修改入参）
 */
function rankCandidates(content, candidates, options = {}) {
  const limit = Number(options.limit) || 12;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const scored = scoreCandidates(content, candidates).map(s => ({
    ...s,
    finalScore: s.score + (s.exec.isFavorite ? FAVORITE_BONUS : 0)
  }));

  // 默认执行硬置顶：兜底时总要有个确定的目标
  const defaultItems = scored.filter(s => s.exec.isDefault);
  const rest = scored
    .filter(s => !s.exec.isDefault)
    .sort((a, b) => b.finalScore - a.finalScore);

  const ordered = [...defaultItems, ...rest].slice(0, limit);

  console.log(
    `[候选预筛] 「${String(content).slice(0, 20)}」 ${candidates.length} → ${ordered.length}`,
    ordered.slice(0, 5).map(s => `${s.exec.id}:${s.exec.name}(${s.finalScore.toFixed(2)})`).join(' ')
  );

  return ordered.map(s => s.exec);
}

export { rankCandidates, scoreCandidates, similarity };