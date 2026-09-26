# JTES 数据集申请邮件草稿

> 用途：向 JTES 作者申请研究授权（日语 SER 训练+评估数据）。
> 状态：模板已备好，**收件邮箱需以官网/论文为准自行确认后填入**。

---

## 0. 申请对象与来源

- **数据集**：JTES（Japanese Twitter-based Emotional Speech corpus）v1.1
- **论文**：Emika Takeishi, Takashi Nose, Yuya Chiba, Akinori Ito, *"Construction and Analysis of Phonetically and Prosodically Balanced Emotional Speech Database"*, O-COCOSDA 2016. DOI: `10.1109/ICSDA.2016.7918977`
- **获取方式**：JTES 无公开直链下载，需向作者（能势 隆 先生 / 伊藤 彰則 先生 团队）发邮件申请授权。**收件邮箱请从论文作者页或实验室官网确认**（不同年份作者归属有变动，务必核实到现任通讯作者）。
- **使用限制**：仅研究用途、禁止二次分发、成果须引用原始论文。

---

## 1. 日文版（推荐 —— 面向日本教授，更得体）

```
件名：【研究利用のお願い】JTES 音声感情データベースのご提供について

〇〇大学〇〇研究科
能勢 隆 先生

拝啓

突然のご連絡で失礼いたします。
私は〇〇大学〇〇学部〇〇学科に在籍しております〇〇（氏名）と申します。
現在、日本語音声における感情認識（Speech Emotion Recognition）の研究に取り組んでおり、
その研究データとして、先生方が構築された JTES（Japanese Twitter-based Emotional Speech corpus）
を利用させていただきたく、ご連絡差し上げました。

【研究概要】
研究テーマは「語彙情報に依存しない、韻律・音質特徴のみによる日本語音声感情認識」です。
具体的には、音声のピッチ（F0）・エネルギー・発話速度・声質（jitter/shimmer）といった
副言語的特徴から、話者の感情（喜び・怒り・悲しみ・中性）を識別するモデルを構築し、
どの特徴がどの感情の識別に寄与するかを定量的に分析することを目的としております。

JTES は、音素・韻律バランスが考慮され、100 名の話者による 20,000 発話という規模で
感情カテゴリが付与された、日本語 SER 研究において最も標準的なデータベースであり、
本研究の基盤データとして是非利用させていただきたく存じます。

【利用条件の遵守について】
以下の点を厳守いたします。
1. 研究目的のみに使用し、営利目的には使用しません。
2. データの再配布・第三者への提供は行いません。
3. 研究成果の発表時には、貴データベースを引用文献として明記いたします。
4. ご指示いただいた利用規約に従います。

ご多忙のところ恐れ入りますが、データのご提供についてご検討いただけますと幸いです。
何卒よろしくお願い申し上げます。

敬具

〇〇〇〇（氏名）
所属：〇〇大学〇〇学部〇〇学科
メール：〇〇@〇〇
```

---

## 2. 英文版（备选）

```
Subject: Request for research use of the JTES emotional speech database

Dear Prof. Nose,

I hope this message finds you well.

My name is [Full Name], a student at [University / Department].
I am currently working on Japanese speech emotion recognition (SER), specifically
on recognizing emotions (joy / anger / sadness / neutral) from paralinguistic
features alone — pitch, energy, speaking rate, and voice quality — without relying
on lexical content.

I would like to request access to the JTES (Japanese Twitter-based Emotional Speech)
corpus for this research. As a phonetically and prosodically balanced database of
20,000 utterances by 100 speakers, JTES is the standard benchmark for Japanese SER,
and it would serve as the primary training and evaluation data for my work.

I will strictly adhere to the following conditions:
1. Use the data for research purposes only, with no commercial use.
2. Not redistribute the data or share it with any third party.
3. Cite your database in any resulting publication.
4. Follow any additional terms you specify.

I would be very grateful for your consideration.

Sincerely,
[Full Name]
[Affiliation]
[Email]
```

---

## 3. 申请要点（为什么这样写，面试也可讲）

1. **开门见山说清用途**：直接点明「纯副语言（paralinguistic）情绪识别」——既诚实，又让作者看到这是 JTES 的设计初衷（JTES 本来就是为「音素+韵律平衡」造的，专门给 SER 用）。
2. **主动承诺四条限制**：研究用途、不二次分发、引用、遵守规约——这是拿到授权的前提，学术数据集作者最在意的就是这几点，提前写出来能显著提高通过率。
3. **日文优先**：面向日本教授，日文更得体，也顺带证明你的日语能力（面试时这是加分项）。

---

## 4. 申请期间的替代/并行方案（不干等）

JTES 授权可能数周。等待期间可并行：

1. **词义隔离实验（RQ3）**：用已有的 GPT-SoVITS 合成「同一句台词 × 6 情绪」对照集（demo A/C 组已现成），先验证「模型跟语气还是跟词义」的实验设计。**注意：这是受控实验工具，不是训练数据。**
2. **eGeMAPS 特征管线搭好**：`openSMILE` 装好、脚本写好，JTES 一到手就能直接抽特征跑基线。
3. **自建 ASMR 素材**：M1 的 ≥10 分钟授权素材到位后，作为域内真人测试集（与 JTES 互补）。
4. **备选数据集**：OGVC（日语，9 情绪，4 声优）、Keio-ESD（日语男声，47 情绪）也可一并申请，多一条路。
