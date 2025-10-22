import { StatisticData } from './StatisticData.js';
import skill_names from '../tables/skill_names.json' with { type: 'json' };

const skillConfig = skill_names.skill_names;

const STAT_TYPES = {
    DAMAGE: 'damage',
    HEALING: 'healing',
};

// éviter le “magic number”
const HEAL_OFFSET = 1_000_000_000;

function getSubProfessionBySkillId(skillId) {
    switch (skillId) {
        case 1241: return 'frostbeam';
        case 2307:
        case 2361:
        case 55302: return 'concerto';
        case 20301: return 'lifebind';
        case 1518:
        case 1541:
        case 21402: return 'smite';
        case 2306: return 'dissonance';
        case 120901:
        case 120902: return 'icicle';
        case 1714:
        case 1734: return 'iaido';
        case 44701:
        case 179906: return 'moonstrike';
        case 220112:
        case 2203622: return 'falconry';
        case 2292:
        case 1700820:
        case 1700825:
        case 1700827: return 'wildpack';
        case 1419: return 'vanguard';
        case 1405:
        case 1418: return 'skyward';
        case 2405: return 'shield';
        case 2406: return 'recovery';
        case 199902: return 'earthfort';
        case 1930:
        case 1931:
        case 1934:
        case 1935: return 'block';
        default: return '';
    }
}

export class UserData {
    constructor(uid) {
        this.uid = uid;
        this.name = '';
        this.damageStats = new StatisticData(this, STAT_TYPES.DAMAGE);
        this.healingStats = new StatisticData(this, STAT_TYPES.HEALING);
        this.takenDamage = 0; // 承伤
        this.deadCount = 0;   // 死亡次数
        this.profession = '...';
        this.skillUsage = new Map(); // 技能使用情况
        this.fightPoint = 0;  // 总评分
        this.subProfession = '';
        this.attr = {};
        this.lastUpdateTime = Date.now();
    }

    _touch() { this.lastUpdateTime = Date.now(); }

    updateSubProfession(skillId) {
        const subProfession = getSubProfessionBySkillId(skillId);
        if (subProfession && this.subProfession !== subProfession) {
            this.setSubProfession(subProfession);
        }
    }

    /** 添加伤害记录 */
    addDamage(skillId, element, damage, isCrit, isLucky, isCauseLucky, hpLessenValue = 0) {
        this._touch();
        this.damageStats.addRecord(damage, isCrit, isLucky, hpLessenValue);

        if (!this.skillUsage.has(skillId)) {
            this.skillUsage.set(skillId, new StatisticData(this, STAT_TYPES.DAMAGE, element));
        }
        this.skillUsage.get(skillId).addRecord(damage, isCrit, isCauseLucky, hpLessenValue);
        this.skillUsage.get(skillId).realtimeWindow.length = 0;

        this.updateSubProfession(skillId);
    }

    /** 添加治疗记录 */
    addHealing(skillId, element, healing, isCrit, isLucky, isCauseLucky) {
        this._touch();
        this.healingStats.addRecord(healing, isCrit, isLucky);

        // 将治疗技能映射到不同区间以避免与伤害技能冲突
        const healSkillId = skillId + HEAL_OFFSET;

        if (!this.skillUsage.has(healSkillId)) {
            this.skillUsage.set(healSkillId, new StatisticData(this, STAT_TYPES.HEALING, element));
        }
        this.skillUsage.get(healSkillId).addRecord(healing, isCrit, isCauseLucky);
        this.skillUsage.get(healSkillId).realtimeWindow.length = 0;

        // 子职业识别仍需原始 skillId
        this.updateSubProfession(skillId);
    }

    /** 添加承伤记录 */
    addTakenDamage(damage, isDead) {
        this._touch();
        this.takenDamage += damage;
        if (isDead) this.deadCount++;
    }

    /** 更新实时DPS和HPS */
    updateRealtimeDps() {
        this.damageStats.updateRealtimeStats();
        this.healingStats.updateRealtimeStats();
    }

    getTotalDps() { return this.damageStats.getTotalPerSecond(); }
    getTotalHps() { return this.healingStats.getTotalPerSecond(); }

    /** 获取合并的次数统计 */
    getTotalCount() {
        return {
            normal: this.damageStats.count.normal + this.healingStats.count.normal,
            critical: this.damageStats.count.critical + this.healingStats.count.critical,
            lucky: this.damageStats.count.lucky + this.healingStats.count.lucky,
            total: this.damageStats.count.total + this.healingStats.count.total,
        };
    }

    /** 获取用户数据摘要 */
    getSummary() {
        return {
            realtime_dps: this.damageStats.realtimeStats.value,
            realtime_dps_max: this.damageStats.realtimeStats.max,
            total_dps: this.getTotalDps(),
            total_damage: { ...this.damageStats.stats },
            total_count: this.getTotalCount(),
            realtime_hps: this.healingStats.realtimeStats.value,
            realtime_hps_max: this.healingStats.realtimeStats.max,
            total_hps: this.getTotalHps(),
            total_healing: { ...this.healingStats.stats },
            taken_damage: this.takenDamage,
            profession: this.profession + (this.subProfession ? ` ${this.subProfession}` : ''),
            subProfession: this.subProfession,
            name: this.name,
            fightPoint: this.fightPoint,
            hp: this.attr.hp,
            max_hp: this.attr.max_hp,
            dead_count: this.deadCount,
        };
    }

    /** 获取技能统计数据 */
    getSkillSummary() {
        const skills = {};
        for (const [skillId, stat] of this.skillUsage) {
            const total = stat.stats.normal + stat.stats.critical + stat.stats.lucky + stat.stats.crit_lucky;
            const critCount = stat.count.critical;
            const luckyCount = stat.count.lucky;
            const critRate = stat.count.total > 0 ? critCount / stat.count.total : 0;
            const luckyRate = stat.count.total > 0 ? luckyCount / stat.count.total : 0;

            // 去掉治疗偏移，查名字
            const baseSkillId = skillId % HEAL_OFFSET;
            const name = skillConfig[baseSkillId] ?? baseSkillId;
            const elementype = stat.element;

            skills[skillId] = {
                displayName: name,
                type: stat.type,                // now 'damage' | 'healing' via STAT_TYPES
                elementype: elementype,
                totalDamage: stat.stats.total,
                totalCount: stat.count.total,
                critCount: stat.count.critical,
                luckyCount: stat.count.lucky,
                critRate: critRate,
                luckyRate: luckyRate,
                damageBreakdown: { ...stat.stats },
                countBreakdown: { ...stat.count },
            };
        }
        return skills;
    }

    setProfession(profession) {
        this._touch();
        if (profession !== this.profession) this.setSubProfession('');
        this.profession = profession;
    }

    setSubProfession(subProfession) {
        this._touch();
        this.subProfession = subProfession;
    }

    setName(name) {
        this._touch();
        this.name = name;
    }

    setFightPoint(fightPoint) {
        this._touch();
        this.fightPoint = fightPoint;
    }

    setAttrKV(key, value) {
        this._touch();
        this.attr[key] = value;
    }

    reset() {
        this.damageStats.reset();
        this.healingStats.reset();
        this.takenDamage = 0;
        this.skillUsage.clear();
        this.fightPoint = 0;
        this._touch();
    }
}
