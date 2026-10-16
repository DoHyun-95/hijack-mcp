#!/usr/bin/env node
/**
 * 하이잭 학생 리포트 MCP 서버 (stdio)
 *
 * 환경변수
 *   HIJACK_SITE_URL  학원 사이트 주소 (예: https://academy.example.com)
 *   HIJACK_API_KEY   관리자 모드 > 사이트 설정 > AI 연동 키에서 발급한 키
 *
 * 주의: stdout은 MCP 프로토콜 전용이므로 로그는 console.error만 사용한다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SITE_URL = (process.env.HIJACK_SITE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.HIJACK_API_KEY || '').trim();
const REQUEST_TIMEOUT_MS = 30_000;
const BASE_SECTIONS = ['schedule', 'assignments', 'video', 'omr'];

if (!/^https?:\/\/[^/\s]+$/.test(SITE_URL)) {
    console.error('[hijack-report-mcp] HIJACK_SITE_URL이 올바르지 않습니다. 예: https://academy.example.com');
    process.exit(1);
}
if (!/^hjk_[0-9a-f]{48}$/.test(API_KEY)) {
    console.error('[hijack-report-mcp] HIJACK_API_KEY가 올바르지 않습니다. 관리자 모드 > 사이트 설정 > AI 연동 키에서 발급하세요.');
    process.exit(1);
}

// ─────────────────────────────────────────────
// 사이트 관리자 API 호출
// ─────────────────────────────────────────────
async function callApi(method, path, { query = {}, body } = {}) {
    const url = new URL(`/api/admin/${path}`, SITE_URL);
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let res;
    try {
        res = await fetch(url, {
            method,
            headers: {
                'X-API-Key': API_KEY,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            // 리다이렉트를 따라가면 키가 다른 주소로 전송될 수 있어 막는다
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (e) {
        throw new Error(`사이트에 연결하지 못했습니다 (${url.host}): ${e.message}`);
    }

    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') || '(주소 없음)';
        throw new Error(`HTTP ${res.status}: 사이트가 ${location}(으)로 이동합니다. HIJACK_SITE_URL을 해당 주소로 바꿔주세요.`);
    }

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`HTTP ${res.status}: JSON이 아닌 응답입니다${text ? ` — ${text.slice(0, 200)}` : ' (빈 응답)'}`);
    }
    if (!json.success) {
        throw new Error(`HTTP ${res.status}: ${json.message || '요청이 실패했습니다.'}`);
    }
    return json.data ?? {};
}

// 공개 열람 링크 토큰과 발행 스냅샷 원문은 AI에 넘기지 않는다
function withoutToken(report) {
    if (!report) return report;
    const { rp_token, rp_data, ...rest } = report;
    return rest;
}

function sectionsFor(includeConsultations) {
    return includeConsultations ? [...BASE_SECTIONS, 'consultations'] : BASE_SECTIONS;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.');

// ─────────────────────────────────────────────
// MCP 서버
// ─────────────────────────────────────────────
const server = new McpServer(
    { name: 'hijack-report', version: '0.4.0' },
    {
        instructions: [
            '하이잭 학원 사이트의 학생 데이터(출결, 과제, 영상 시청, OMR 성적, 상담기록)를 조회하고 학생 리포트 초안을 작성하며, OMR 시험(정답)을 등록하는 도구입니다.',
            '학생을 지정할 때는 먼저 list_students로 mb_id를 확인하세요.',
            '학생 데이터 응답의 analysis 블록을 먼저 보세요: metrics(지표별 이번/이전 기간 값과 변화량), signals(위험 신호), highlights(잘한 점), overall(good=순조로움, watch=점검 권장, alert=관심 필요).',
            '분석·총평에 쓰는 숫자는 analysis와 응답 데이터에 있는 값만 인용하고, 직접 계산하거나 추정하지 마세요.',
            '시험 성적은 analysis.omr_boards(시험 종류=게시판별)로 보세요. 같은 종류끼리만 비교하고, 서로 다른 종류(예: 모의고사와 단어 테스트)의 점수를 섞어 평균 내거나 비교하지 마세요. 실력 추이는 1차 점수(first_avg) 기준이며, 재시험은 만회 폭(retake_gain)으로 따로 말하세요. metrics.omr_average는 종류가 섞인 값이라 쓰지 마세요.',
            'signals는 원장님·선생님용 정보입니다. 학부모용 총평에는 위험 신호를 그대로 쓰지 말고 개선 방향과 다음 계획으로 순화해 쓰세요.',
            'DATA_UNRECORDED 신호가 있으면 출석률을 신뢰하기 어려우니 출석에 대한 단정적인 평가를 피하세요.',
            '리포트는 초안까지만 만들 수 있습니다. 발행·삭제·알림톡 발송은 원장님/선생님이 관리자 화면에서 직접 합니다.',
            '상담기록은 민감정보이므로 사용자가 요청했을 때만 include_consultations=true로 조회하세요.',
            'OMR 시험(정답) 등록: PDF 등에서 정답을 추출해 list_omr_boards로 고른 이 사이트 전용 게시판에 create_omr_exams로 등록합니다.',
            '등록 순서는 반드시 ① create_omr_exams(dry_run=true)로 검증 → ② 회차별 정답표(번호: 정답)와 warnings/errors를 사용자에게 보여주고 확인받기 → ③ 사용자가 확인한 뒤에만 dry_run=false로 등록입니다. 확인 없이 등록하지 마세요.',
            '정답은 PDF에 있는 문항 번호 그대로 넣고(예: 18~45번), ①②③④⑤는 1~5 숫자로 바꾸세요. 복수 정답은 "1,4", 단답형은 types에 "text"로 표시합니다. 읽기 어려운 문항은 추측하지 말고 사용자에게 물어보세요.',
            '등록한 시험은 이 도구로 수정·삭제할 수 없습니다. 잘못 등록했다면 관리자 화면에서 직접 고치도록 안내하세요.',
        ].join('\n'),
    },
);

function registerTool(name, config, handler) {
    server.registerTool(name, config, async (args) => {
        try {
            const data = await handler(args);
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (e) {
            return { isError: true, content: [{ type: 'text', text: e.message }] };
        }
    });
}

registerTool('list_students', {
    title: '학생·그룹 목록',
    description: '학생 목록(mb_id, 이름)과 회원 그룹(반) 목록을 조회합니다. query로 이름/아이디를 검색할 수 있습니다.',
    inputSchema: {
        query: z.string().optional().describe('이름, 닉네임 또는 아이디 일부'),
    },
}, async ({ query }) => {
    const data = await callApi('GET', 'student-list.php');
    const keyword = (query || '').trim().toLowerCase();
    // 관리자(레벨 10 이상) 제외, 연락처는 AI에 넘기지 않음
    const students = (data.members || [])
        .filter((m) => Number(m.mb_level) < 10)
        .filter((m) => !keyword || [m.mb_id, m.mb_name, m.mb_nick].some((v) => (v || '').toLowerCase().includes(keyword)))
        .map(({ mb_id, mb_name, mb_nick, mb_level }) => ({ mb_id, mb_name, mb_nick, mb_level }));
    const groups = (data.groups || []).map(({ group_id, group_name, members }) => ({ group_id, group_name, members }));
    return { total: students.length, students, groups };
});

registerTool('get_student_data', {
    title: '학생 기간별 학습 데이터',
    description: '학생 한 명의 기간 내 수업 일정·출결, 과제 완료, 영상 시청률, OMR 시험 점수(1차/재시험)를 집계해 가져옵니다. 이전 기간 대비 변화·위험 신호·잘한 점이 담긴 analysis 블록이 함께 옵니다. 리포트를 만들지 않고 분석할 때 사용합니다.',
    inputSchema: {
        mb_id: z.string().min(1).describe('학생 아이디 (list_students로 확인)'),
        from: dateSchema.describe('시작일 YYYY-MM-DD'),
        to: dateSchema.describe('종료일 YYYY-MM-DD'),
        include_consultations: z.boolean().optional().describe('상담기록 포함 여부 (민감정보, 기본 false)'),
    },
}, async ({ mb_id, from, to, include_consultations }) => callApi('GET', 'report.php', {
    query: { action: 'collect', mb_id, from, to, sections: sectionsFor(include_consultations).join(',') },
}));

registerTool('list_reports', {
    title: '리포트 목록',
    description: '작성된 학생 리포트 목록을 조회합니다 (최신순, 20개씩).',
    inputSchema: {
        mb_id: z.string().optional().describe('특정 학생만 조회'),
        status: z.enum(['draft', 'published']).optional().describe('draft=초안, published=발행됨'),
        page: z.number().int().min(1).optional(),
    },
}, async ({ mb_id, status, page }) => {
    const data = await callApi('GET', 'report.php', { query: { action: 'list', mb_id, status, page, per_page: 20 } });
    return { ...data, reports: (data.reports || []).map(withoutToken) };
});

registerTool('get_report', {
    title: '리포트 상세',
    description: '리포트 한 건의 정보(제목, 기간, 상태, 총평)와 해당 기간의 집계 데이터를 가져옵니다.',
    inputSchema: {
        rp_id: z.number().int().min(1),
    },
}, async ({ rp_id }) => {
    const data = await callApi('GET', 'report.php', { query: { action: 'data', rp_id } });
    return { ...data, report: withoutToken(data.report) };
});

registerTool('create_report_draft', {
    title: '리포트 초안 만들기',
    description: '학생 리포트를 초안(draft) 상태로 만듭니다. 발행은 관리자 화면에서 사람이 합니다. "초안 작성" 권한 키가 필요합니다.',
    inputSchema: {
        mb_id: z.string().min(1),
        period_from: dateSchema,
        period_to: dateSchema,
        title: z.string().min(1).max(200).describe('예: 9월 학습 리포트'),
        teacher_comment: z.string().optional().describe('학부모에게 보여질 총평'),
        include_consultations: z.boolean().optional().describe('리포트에 상담기록 섹션 포함 여부 (기본 false)'),
    },
}, async ({ mb_id, period_from, period_to, title, teacher_comment, include_consultations }) => {
    const data = await callApi('POST', 'report.php', {
        body: { mb_id, period_from, period_to, title, teacher_comment, sections: sectionsFor(include_consultations) },
    });
    return { rp_id: data.rp_id, status: 'draft', message: '초안이 생성되었습니다. 관리자 화면 학생리포트에서 확인 후 발행하세요.' };
});

registerTool('update_report_draft', {
    title: '리포트 초안 총평 수정',
    description: '초안 상태 리포트의 총평(과 제목)을 수정합니다. 발행된 리포트는 수정할 수 없습니다. "초안 작성" 권한 키가 필요합니다.',
    inputSchema: {
        rp_id: z.number().int().min(1),
        teacher_comment: z.string().min(1).describe('새 총평 전체 내용 (기존 총평을 대체)'),
        title: z.string().max(200).optional(),
    },
}, async ({ rp_id, teacher_comment, title }) => {
    await callApi('PUT', 'report.php', { body: { rp_id, action: 'update', teacher_comment, title } });
    return { rp_id, message: '초안이 수정되었습니다.' };
});

registerTool('list_omr_boards', {
    title: 'OMR 게시판 목록',
    description: '이 사이트에서 시험(정답)을 등록할 수 있는 OMR 게시판과 분류 목록을 조회합니다. bo_table을 주면 그 게시판의 최근 시험 제목을 보여줍니다(회차 이름·중복 확인용). 본사 공용 게시판은 등록할 수 없어 제외합니다.',
    inputSchema: {
        bo_table: z.string().optional().describe('최근 시험을 볼 게시판 (생략하면 게시판 목록)'),
    },
}, async ({ bo_table }) => {
    if (bo_table) {
        const data = await callApi('GET', 'omr.php', { query: { action: 'posts', bo_table } });
        const exams = (data.posts || []).slice(0, 30)
            .map(({ wr_id, wr_subject, wr_datetime, participant_count }) => ({ wr_id, wr_subject, wr_datetime, participant_count }));
        return { bo_table, recent_exams: exams };
    }
    const data = await callApi('GET', 'omr.php', { query: { action: 'boards' } });
    const all = data.boards || [];
    const boards = all.filter((b) => b.writable).map((b) => ({
        bo_table: b.bo_table,
        bo_subject: b.bo_subject,
        categories: Number(b.bo_use_category) ? (b.bo_category_list || '').split('|').filter(Boolean) : [],
    }));
    return { total: boards.length, hq_boards_excluded: all.length - boards.length, boards };
});

const examSchema = z.object({
    title: z.string().min(1).max(255).describe('시험 제목 (예: 중2 듣기 Book1 Day5)'),
    answers: z.record(z.string()).describe('문항 번호 → 정답. 예: {"18":"3","19":"1,4","20":"apple"}'),
    types: z.record(z.enum(['number', 'text', 'essay'])).optional().describe('객관식이 아닌 문항만 표시. 예: {"20":"text"}'),
    content: z.string().optional().describe('본문 (생략 시 "문제 18~45")'),
    ca_name: z.string().optional().describe('분류 (list_omr_boards의 categories 중 하나)'),
});

registerTool('create_omr_exams', {
    title: 'OMR 시험(정답) 등록',
    description: 'OMR 게시판에 시험을 정답과 함께 등록합니다(최대 50개). 기본은 dry_run=true로 저장 없이 검증만 합니다. 사용자가 검증 결과(정답표)를 확인한 뒤에만 dry_run=false로 실제 등록하세요. "초안 + OMR 등록" 권한 키가 필요합니다.',
    inputSchema: {
        bo_table: z.string().min(1).describe('list_omr_boards로 확인한 게시판'),
        exams: z.array(examSchema).min(1).max(50),
        dry_run: z.boolean().optional().describe('true(기본)=검증만, false=실제 등록'),
    },
}, async ({ bo_table, exams, dry_run }) => callApi('POST', 'omr.php', {
    query: { action: 'create-exams' },
    body: { bo_table, exams, dry_run: dry_run !== false },
}));

await server.connect(new StdioServerTransport());
console.error(`[hijack-report-mcp] ${SITE_URL} 연결 준비 완료`);
