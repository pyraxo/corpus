// Default Corpus taxonomy. SKOS-shaped: stable concept IDs, a preferred label,
// a broader concept (parent), and aliases used for matching. Facets are
// orthogonal axes (topic, format, kind, contains, source). Users can add,
// rename, re-parent, or retire concepts; edits live in data/state.json and are
// layered over these defaults at build time.

export const facets = [
  { id: 'topic', label: 'Topic', multi: true, description: 'What it is about' },
  { id: 'kind', label: 'Kind', multi: true, description: 'What sort of thing it is' },
  { id: 'format', label: 'Format', multi: false, description: 'Shape of the content' },
  { id: 'contains', label: 'Contains', multi: true, description: 'Attachments' },
  { id: 'source', label: 'Source', multi: false, description: 'Where it came from' },
  { id: 'label', label: 'Labels', multi: true, description: 'Your own labels' }
];

// [id, label, aliases, fieldtheory domains/categories that imply it]
const topics = [
  ['topic:ai', 'AI', ['artificial intelligence', 'llm', 'llms', 'machine learning', 'deep learning', 'neural net', 'gpt', 'openai', 'anthropic', 'gemini', 'deepmind'], ['ai', 'ai-news', 'ai-art', 'ai-business', 'ai-policy']],
  ['topic:ai/agents', 'Agents', ['agent', 'agents', 'agentic', 'multi-agent', 'subagent', 'subagents', 'autonomous', 'computer use', 'browser use', 'tool use', 'tool calling', 'mcp', 'a2a']],
  ['topic:ai/coding', 'AI coding', ['claude code', 'codex', 'cursor', 'copilot', 'vibe coding', 'vibecoding', 'windsurf', 'amp code', 'coding agent', 'coding agents', 'opencode', 'aider', 'devin']],
  ['topic:ai/prompting', 'Prompting', ['prompt', 'prompts', 'prompting', 'system prompt', 'prompt engineering', 'context engineering', 'few-shot']],
  ['topic:ai/evals', 'Evals', ['eval', 'evals', 'evaluation', 'evaluations', 'benchmark', 'benchmarks', 'hillclimb', 'hillclimbing', 'llm-as-judge', 'grader', 'swe-bench']],
  ['topic:ai/models', 'Models & releases', ['opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-4', 'o3', 'llama', 'qwen', 'deepseek', 'mistral', 'kimi', 'grok', 'open weights', 'open-source model', 'model release']],
  ['topic:ai/training', 'Training & research', ['fine-tune', 'fine-tuning', 'finetuning', 'rlhf', 'reinforcement learning', 'pretraining', 'post-training', 'distillation', 'interpretability', 'alignment', 'transformer', 'attention', 'scaling law', 'lora']],
  ['topic:ai/rag', 'Retrieval & memory', ['rag', 'retrieval', 'embeddings', 'embedding', 'vector db', 'vector database', 'semantic search', 'memory layer', 'knowledge graph']],
  ['topic:ai/skills', 'Skills & harnesses', ['skill', 'skills', 'harness', 'claude.md', 'agents.md', 'hooks', 'slash command', 'plugins']],
  ['topic:ai/media', 'Generative media', ['image generation', 'video generation', 'midjourney', 'sora', 'veo', 'flux', 'stable diffusion', 'nano banana', 'text-to-video', 'text-to-image', 'voice clone', 'tts', 'elevenlabs', 'suno']],
  ['topic:ai/local', 'Local & on-device', ['local llm', 'ollama', 'llama.cpp', 'mlx', 'on-device', 'gguf', 'vllm', 'quantization', 'quantized']],

  ['topic:engineering', 'Engineering', ['software', 'programming', 'developer', 'developers', 'engineer', 'engineering', 'codebase', 'open source'], ['web-dev', 'devops', 'software-engineering']],
  ['topic:engineering/frontend', 'Frontend', ['react', 'next.js', 'nextjs', 'css', 'tailwind', 'svelte', 'vue', 'frontend', 'front-end', 'html', 'shadcn', 'three.js', 'threejs', 'webgl', 'animation library', 'framer motion']],
  ['topic:engineering/backend', 'Backend & data', ['backend', 'database', 'postgres', 'sqlite', 'sql', 'redis', 'api design', 'graphql', 'rust', 'golang', 'python', 'node.js', 'bun', 'deno', 'supabase']],
  ['topic:engineering/infra', 'Infra & DevOps', ['kubernetes', 'k8s', 'docker', 'terraform', 'aws', 'gcp', 'azure', 'cloudflare', 'serverless', 'devops', 'ci/cd', 'observability', 'self-host', 'self-hosted', 'homelab', 'vps']],
  ['topic:engineering/tools', 'Dev tools', ['cli', 'terminal', 'neovim', 'vim', 'vscode', 'git', 'github', 'tmux', 'shell', 'zsh', 'dotfiles', 'ide']],
  ['topic:engineering/mobile', 'Mobile', ['ios', 'android', 'swift', 'swiftui', 'react native', 'expo', 'mobile app']],
  ['topic:engineering/practice', 'Engineering practice', ['code review', 'testing', 'refactor', 'refactoring', 'architecture', 'system design', 'tech debt', 'best practices', 'debugging']],

  ['topic:design', 'Design', ['design', 'designer', 'designers'], ['design']],
  ['topic:design/web', 'Web & sites', ['website', 'landing page', 'web design', 'portfolio', 'site design', 'framer', 'webflow']],
  ['topic:design/interface', 'Interface & UX', ['ui', 'ux', 'interface', 'interaction design', 'design system', 'components', 'component', 'figma', 'micro-interaction', 'microinteraction']],
  ['topic:design/type', 'Typography', ['typography', 'typeface', 'font', 'fonts', 'lettering', 'kerning']],
  ['topic:design/motion', 'Motion', ['motion design', 'motion', 'animation', 'animations', 'animated', 'after effects', 'rive', 'lottie', 'shader', 'shaders']],
  ['topic:design/brand', 'Brand & identity', ['brand', 'branding', 'logo', 'visual identity', 'packaging']],
  ['topic:design/3d', '3D & spatial', ['3d', 'blender', 'spline', 'cinema 4d', 'spatial', 'vision pro']],

  ['topic:business', 'Business & startups', ['startup', 'startups', 'founder', 'founders', 'business', 'company', 'yc', 'y combinator', 'venture', 'vc'], ['startups', 'commerce', 'business', 'startup-ideas']],
  ['topic:business/product', 'Product', ['product management', 'product manager', 'roadmap', 'user research', 'product market fit', 'pmf', 'onboarding']],
  ['topic:business/growth', 'Growth & marketing', ['growth', 'marketing', 'seo', 'distribution', 'audience', 'go-to-market', 'gtm', 'viral', 'ads', 'copywriting', 'newsletter'], ['marketing']],
  ['topic:business/sales', 'Sales', ['sales', 'cold email', 'outbound', 'pipeline', 'crm', 'pricing']],
  ['topic:business/fundraising', 'Fundraising', ['fundraising', 'seed round', 'series a', 'investors', 'pitch deck']],
  ['topic:business/indie', 'Indie & solo', ['indie hacker', 'indiehacker', 'solopreneur', 'bootstrapped', 'side project', 'mrr', 'arr']],

  ['topic:work', 'Work & career', ['career', 'job', 'jobs', 'hiring', 'interview', 'resume', 'salary', 'manager', 'management', 'leadership'], ['career']],
  ['topic:work/productivity', 'Productivity', ['productivity', 'productive', 'deep work', 'time management', 'todo', 'to-do', 'calendar', 'routine', 'habit', 'habits'], ['productivity']],
  ['topic:work/knowledge', 'Notes & knowledge', ['notes', 'note-taking', 'obsidian', 'notion', 'second brain', 'pkm', 'zettelkasten', 'bookmarks', 'personal knowledge']],
  ['topic:work/writing', 'Writing', ['writing', 'writer', 'essay', 'essays', 'blog post', 'storytelling'], ['writing', 'creative-writing']],
  ['topic:work/learning', 'Learning', ['learning', 'course', 'tutorial', 'lecture', 'curriculum', 'study', 'education', 'teaching'], ['education', 'learning-resources']],

  ['topic:health', 'Health', ['health', 'healthcare', 'medical', 'medicine', 'doctor', 'clinic', 'hospital', 'disease', 'longevity'], ['health']],
  ['topic:health/fitness', 'Fitness', ['fitness', 'workout', 'exercise', 'gym', 'strength training', 'running', 'marathon', 'cardio', 'zone 2', 'lifting', 'mobility']],
  ['topic:health/nutrition', 'Nutrition', ['nutrition', 'diet', 'protein', 'fasting', 'supplement', 'supplements', 'calories', 'glucose']],
  ['topic:health/mind', 'Mental health', ['mental health', 'anxiety', 'depression', 'therapy', 'therapist', 'meditation', 'mindfulness', 'burnout', 'stress']],
  ['topic:health/sleep', 'Sleep', ['sleep', 'insomnia', 'circadian', 'melatonin']],

  ['topic:living', 'Living', ['lifestyle', 'living'], ['self-improvement', 'personal-development', 'mindset', 'relationships', 'local']],
  ['topic:living/home', 'Home', ['apartment', 'interior', 'furniture', 'house', 'renovation', 'garden', 'gardening']],
  ['topic:living/food', 'Food & cooking', ['food', 'cooking', 'recipe', 'recipes', 'restaurant', 'coffee', 'baking', 'chef']],
  ['topic:living/travel', 'Travel', ['travel', 'trip', 'flight', 'flights', 'hotel', 'itinerary', 'visa', 'nomad'], ['travel']],
  ['topic:living/relationships', 'Relationships', ['relationship', 'relationships', 'dating', 'marriage', 'friendship', 'parenting', 'kids']],
  ['topic:living/style', 'Style', ['fashion', 'outfit', 'clothing', 'wardrobe']],
  ['topic:living/growth', 'Personal growth', ['self-improvement', 'discipline', 'motivation', 'mindset', 'purpose', 'happiness']],

  ['topic:money', 'Money', ['money', 'finance', 'financial', 'economy', 'economics'], ['finance']],
  ['topic:money/investing', 'Investing', ['investing', 'investment', 'stocks', 'stock market', 'etf', 'portfolio', 'trading', 'hedge fund', 'valuation']],
  ['topic:money/crypto', 'Crypto', ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'defi', 'onchain', 'on-chain', 'stablecoin', 'web3', 'polymarket', 'prediction market'], ['crypto', 'web3']],
  ['topic:money/personal', 'Personal finance', ['budget', 'budgeting', 'savings', 'tax', 'taxes', 'retirement', 'mortgage', 'net worth']],

  ['topic:security', 'Security & privacy', ['security', 'privacy', 'vulnerability', 'exploit', 'hacked', 'hacking', 'infosec', 'cybersecurity', 'encryption', 'prompt injection', 'jailbreak', 'malware', 'phishing'], ['security']],
  ['topic:science', 'Science', ['science', 'scientist', 'physics', 'biology', 'chemistry', 'neuroscience', 'math', 'mathematics', 'climate', 'space', 'nasa', 'spacex'], ['science']],
  ['topic:hardware', 'Hardware & robotics', ['hardware', 'robot', 'robots', 'robotics', 'humanoid', 'chip', 'chips', 'gpu', 'gpus', 'nvidia', 'semiconductor', 'arduino', 'raspberry pi', 'drone', 'drones', 'mac mini', 'macbook'], ['hardware', 'robotics', 'defense']],
  ['topic:games', 'Games', ['game', 'games', 'gaming', 'gamedev', 'game dev', 'unity', 'unreal', 'godot', 'indie game'], ['gaming', 'gamedev', 'game-dev', 'game']],
  ['topic:culture', 'Culture & ideas', ['culture', 'philosophy', 'history', 'society', 'book', 'books', 'reading list', 'film', 'movie', 'music', 'art', 'artist', 'psychology'], ['culture', 'art', 'photography', 'creative', 'entertainment', 'humor', 'fun']],
  ['topic:media', 'Media & creators', ['youtube', 'podcast', 'creator', 'creators', 'content creation', 'tiktok', 'instagram', 'social media', 'twitter', 'journalism'], ['media', 'social-media']],
  ['topic:politics', 'Politics & policy', ['politics', 'policy', 'government', 'election', 'regulation', 'law', 'legal', 'geopolitics'], ['politics', 'legal', 'ai-policy']]
];

// FieldTheory's LLM categories map to "kind" — what sort of thing a bookmark is.
const kinds = [
  ['kind:technique', 'How-to / technique', ['how to', 'how i', 'step by step', 'guide', 'tips', 'playbook'], ['technique']],
  ['kind:tool', 'Tool / product', ['tool', 'library', 'open source', 'open-source', 'extension', 'plugin'], ['tool']],
  ['kind:launch', 'Launch / announcement', ['introducing', 'launching', 'announcing', 'just shipped', 'now available', 'we built', 'releasing'], ['launch', 'demo', 'event']],
  ['kind:research', 'Research / paper', ['paper', 'arxiv', 'study', 'findings', 'research'], ['research']],
  ['kind:opinion', 'Opinion / take', ['i think', 'hot take', 'unpopular opinion', 'imo'], ['opinion']],
  ['kind:resource', 'Resource / list', ['list of', 'resources', 'collection', 'curated', 'awesome', 'cheat sheet', 'cheatsheet', 'reading list'], ['resource', 'reference']],
  ['kind:prompt', 'Prompt / example', ['prompt:', 'here is the prompt', 'here’s the prompt', "here's the prompt", 'copy this prompt', 'use this prompt']],
  ['kind:story', 'Story / experience', ['my journey', 'i quit', 'lessons learned', 'what i learned', 'years ago'], ['personal-story']],
  ['kind:news', 'News', ['breaking', 'just announced', 'reportedly'], ['ai-news']],
  ['kind:inspiration', 'Inspiration', ['beautiful', 'stunning', 'gorgeous', 'inspiration', 'inspo']]
];

const formats = [
  ['format:thread', 'Thread'],
  ['format:article', 'Long-form article'],
  ['format:link', 'Link'],
  ['format:repo', 'Repository'],
  ['format:video', 'Video'],
  ['format:image', 'Image'],
  ['format:quote', 'Quote post'],
  ['format:post', 'Post']
];

const contains = [
  ['contains:image', 'Images'],
  ['contains:video', 'Video'],
  ['contains:link', 'External links'],
  ['contains:quote', 'Quoted post'],
  ['contains:code', 'Code / repo']
];

export function defaultConcepts() {
  const out = [];
  const push = (facet, [id, label, aliases = [], ft = []]) => {
    const slash = id.lastIndexOf('/');
    out.push({ id, label, facet, parent: slash > id.indexOf(':') ? id.slice(0, slash) : null, aliases, ft, origin: 'default' });
  };
  topics.forEach(t => push('topic', t));
  kinds.forEach(t => push('kind', t));
  formats.forEach(t => push('format', t));
  contains.forEach(t => push('contains', t));
  push('source', ['source:twitter', 'X / Twitter']);
  push('source', ['source:web', 'Web']);
  return out;
}

// Apply user edits: { concepts: { [id]: partial | {deleted:true} } }
export function mergeTaxonomy(edits = {}) {
  const byId = new Map(defaultConcepts().map(c => [c.id, c]));
  for (const [id, patch] of Object.entries(edits.concepts || {})) {
    if (patch?.deleted) { byId.delete(id); continue; }
    const base = byId.get(id) || { id, facet: patch.facet || id.split(':')[0], aliases: [], ft: [], parent: null, origin: 'user' };
    byId.set(id, { ...base, ...patch, id });
  }
  // Re-home children whose parent was removed.
  for (const c of byId.values()) if (c.parent && !byId.has(c.parent)) c.parent = null;
  return [...byId.values()];
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function compileMatchers(concepts) {
  return concepts.filter(c => c.aliases?.length).map(c => ({
    id: c.id,
    re: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${c.aliases.map(a => escape(a.toLowerCase().trim())).filter(Boolean).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'u')
  }));
}
