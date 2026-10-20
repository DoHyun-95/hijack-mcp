#!/usr/bin/env node
/**
 * 하이잭 MCP 서버 (stdio)
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
    console.error('[hijack-mcp] HIJACK_SITE_URL이 올바르지 않습니다. 예: https://academy.example.com');
    process.exit(1);
}
if (!/^hjk_[0-9a-f]{48}$/.test(API_KEY)) {
    console.error('[hijack-mcp] HIJACK_API_KEY가 올바르지 않습니다. 관리자 모드 > 사이트 설정 > AI 연동 키에서 발급하세요.');
    process.exit(1);
}

// ─────────────────────────────────────────────
// 사이트 관리자 API 호출
// ─────────────────────────────────────────────
async function callApi(method, path, { query = {}, body, form } = {}) {
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
                // $_POST로 받는 API(팝업·메인 디자인)는 form으로 보낸다
                'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
                Accept: 'application/json',
            },
            body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined,
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
    { name: 'hijack', version: '1.0.0' },
    {
        instructions: [
            '하이잭 학원 사이트의 학생 데이터(출결, 과제, 영상 시청, OMR 성적, 상담기록)를 조회하고 학생 리포트 초안을 작성하며, OMR 시험(정답)을 등록하고 게시판·수업 일정·출결·과제·팝업·메인 디자인을 관리하는 도구입니다.',
            '학생을 지정할 때는 먼저 list_students로 mb_id를 확인하세요.',
            '학생 데이터 응답의 analysis 블록을 먼저 보세요: metrics(지표별 이번/이전 기간 값과 변화량), signals(위험 신호), highlights(잘한 점), overall(good=순조로움, watch=점검 권장, alert=관심 필요).',
            '분석·총평에 쓰는 숫자는 analysis와 응답 데이터에 있는 값만 인용하고, 직접 계산하거나 추정하지 마세요.',
            '시험 성적은 analysis.omr_boards(시험 종류=게시판별)로 보세요. 같은 종류끼리만 비교하고, 서로 다른 종류(예: 모의고사와 단어 테스트)의 점수를 섞어 평균 내거나 비교하지 마세요. 실력 추이는 1차 점수(first_avg) 기준이며, 재시험은 만회 폭(retake_gain)으로 따로 말하세요. metrics.omr_average는 종류가 섞인 값이라 쓰지 마세요.',
            'signals는 원장님·선생님용 정보입니다. 학부모용 총평에는 위험 신호를 그대로 쓰지 말고 개선 방향과 다음 계획으로 순화해 쓰세요.',
            'DATA_UNRECORDED 신호가 있으면 출석률을 신뢰하기 어려우니 출석에 대한 단정적인 평가를 피하세요.',
            '리포트는 초안까지만 만들 수 있습니다. 발행과 알림톡 발송은 원장님/선생님이 관리자 화면에서 직접 합니다.',
            '상담기록은 민감정보이므로 사용자가 요청했을 때만 include_consultations=true로 조회하세요.',
            'OMR 시험(정답) 등록: PDF 등에서 정답을 추출해 list_omr_boards로 고른 이 사이트 전용 게시판에 create_omr_exams로 등록합니다.',
            '등록 순서는 반드시 ① create_omr_exams(dry_run=true)로 검증 → ② 회차별 정답표(번호: 정답)와 warnings/errors를 사용자에게 보여주고 확인받기 → ③ 사용자가 확인한 뒤에만 dry_run=false로 등록입니다. 확인 없이 등록하지 마세요.',
            '정답은 PDF에 있는 문항 번호 그대로 넣고(예: 18~45번), ①②③④⑤는 1~5 숫자로 바꾸세요. 복수 정답은 "1,4", 단답형은 types에 "text"로 표시합니다. 읽기 어려운 문항은 추측하지 말고 사용자에게 물어보세요.',
            '등록한 시험은 이 도구로 수정·삭제할 수 없습니다. 잘못 등록했다면 관리자 화면에서 직접 고치도록 안내하세요.',
            '선생님 질문 응답: 수업 일정·출결은 get_schedule → get_attendance, 과제는 list_assignments → get_assignment_status, 영상 시청은 get_video_watch, 반 시험 성적은 get_group_omr, 사이트 현황은 get_site_stats를 쓰세요. 반은 list_students의 groups(group_id, group_name)로 찾습니다.',
            '"안 한 학생"(결석·미제출·미시청) 질문은 대상 학생 목록(반 구성원·과제 대상자)과 기록을 비교해 답하세요. 기록이 없는 학생은 "기록 없음"으로 말하고 결석·미제출로 단정하지 마세요.',
            '게시판 관리: list_boards로 현재 설정을 보고, create_board·update_board는 바꿀 내용(아이디·이름·권한 레벨·분류)을 사용자에게 보여주고 확인받은 뒤에만 호출하세요. 스킨 변경은 관리자 화면에서 직접 하도록 안내하세요. 메뉴는 list_menus로 조회합니다.',
            '일정·출결·과제·팝업·메인 디자인 쓰기 도구도 실행 전에 바꿀 내용을 사용자에게 보여주고 확인받으세요. 출결 저장은 학부모 알림톡, 과제 생성·휴강은 학생 푸시가 관리자 화면과 똑같이 발송되므로 확인할 때 함께 알려주세요.',
            '삭제 도구(delete_*, 이미지 삭제)는 최고 관리자 계정의 "전체" 키로만 됩니다. 다른 키로 권한 오류가 나면 관리자 화면에서 직접 하도록 안내하세요.',
            '삭제는 되돌릴 수 없습니다. 반드시 삭제할 대상(제목·날짜·게시판 이름 등)을 조회해 사용자에게 보여주고, 사용자가 명확히 삭제하라고 한 뒤에만 confirm=true로 호출하세요. 게시판 삭제는 그 안의 글도 모두 사라진다고 꼭 알리세요. clear_board_posts는 게시판은 두고 글·첨부·시청/OMR 기록만 지우고, delete_menu는 하위 메뉴도 함께 지웁니다.',
            '도구로 확인할 수 없는 정보(결제·상담 등)는 추측하지 말고 관리자 화면에서 확인하도록 안내하세요.',
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
    description: '학생 리포트를 초안(draft) 상태로 만듭니다. 발행은 관리자 화면에서 사람이 합니다. "초안" 이상 권한 키가 필요합니다.',
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
    description: '초안 상태 리포트의 총평(과 제목)을 수정합니다. 발행된 리포트는 수정할 수 없습니다. "초안" 이상 권한 키가 필요합니다.',
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
    description: 'OMR 게시판에 시험을 정답과 함께 등록합니다(최대 50개). 기본은 dry_run=true로 저장 없이 검증만 합니다. 사용자가 검증 결과(정답표)를 확인한 뒤에만 dry_run=false로 실제 등록하세요. "전체" 권한 키(또는 이전에 발급한 "초안 + OMR 등록" 키)가 필요합니다.',
    inputSchema: {
        bo_table: z.string().min(1).describe('list_omr_boards로 확인한 게시판'),
        exams: z.array(examSchema).min(1).max(50),
        dry_run: z.boolean().optional().describe('true(기본)=검증만, false=실제 등록'),
    },
}, async ({ bo_table, exams, dry_run }) => callApi('POST', 'omr.php', {
    query: { action: 'create-exams' },
    body: { bo_table, exams, dry_run: dry_run !== false },
}));

// ── 선생님 질문 응답용 조회 도구 (모두 GET, 키 권한과 관리자 메뉴 권한이 그대로 적용됨) ──
const clip = (v, n = 300) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);

registerTool('get_schedule', {
    title: '수업 일정',
    description: '날짜 기준 하루/주(일~토)/월 수업 일정을 조회합니다. 각 일정의 se_id로 get_attendance를 호출하면 출결을 볼 수 있습니다.',
    inputSchema: {
        date: dateSchema.describe('기준 날짜 YYYY-MM-DD'),
        range: z.enum(['day', 'week', 'month']).optional().describe('기본 day'),
        group: z.string().optional().describe('반 이름(se_group)으로 필터'),
    },
}, async ({ date, range = 'day', group }) => {
    const [year, month] = date.split('-').map(Number);
    const query = range === 'month' ? { action: 'month', year, month, group } : { action: range, date, group };
    const data = await callApi('GET', 'schedule.php', { query });
    data.events = (data.events || []).map((e) => ({ ...e, se_memo: clip(e.se_memo) }));
    return data;
});

registerTool('get_attendance', {
    title: '수업 출결',
    description: '수업 일정 한 건(se_id)의 반 학생별 출결(present=출석, absent=결석, late=지각, excused=사유결석, null=기록 없음)을 조회합니다.',
    inputSchema: { se_id: z.number().int().min(1).describe('get_schedule의 se_id') },
}, async ({ se_id }) => callApi('GET', 'schedule.php', { query: { action: 'attendance', id: se_id } }));

registerTool('list_assignments', {
    title: '과제 목록',
    description: '과제 목록(제목, 대상 반, 마감일, 대상/제출 인원)을 최신순으로 조회합니다. mb_id를 주면 그 학생의 과제와 완료 여부를 봅니다.',
    inputSchema: {
        status: z.enum(['active', 'closed']).optional().describe('active=진행중, closed=마감·완료·종료'),
        mb_id: z.string().optional().describe('특정 학생의 과제만'),
        page: z.number().int().min(1).optional(),
    },
}, async ({ status, mb_id, page }) => {
    if (mb_id) {
        return callApi('GET', 'assignment.php', { query: { action: 'student-assignments', mb_id, page, per_page: 50 } });
    }
    const data = await callApi('GET', 'assignment.php', { query: { action: 'assignments', status, page, per_page: 50 } });
    data.assignments = (data.assignments || []).map(({ as_links, as_checklist, as_links_arr, as_content, ...a }) => ({
        ...a, as_content: clip(as_content),
    }));
    return data;
});

registerTool('get_assignment_status', {
    title: '과제 완료 현황',
    description: '과제 한 건의 대상 학생별 완료 여부·완료일·체크리스트 항목 상태를 조회합니다.',
    inputSchema: { as_id: z.number().int().min(1).describe('list_assignments의 as_id') },
}, async ({ as_id }) => callApi('GET', 'assignment.php', { query: { action: 'completion-status', as_id } }));

registerTool('get_video_watch', {
    title: '게시글 영상 시청 기록',
    description: '게시글 영상 시청 기록을 조회합니다. 인자 없음=시청 기록이 있는 게시판 목록, bo_table=게시글별 시청 요약, bo_table+wr_id=그 게시글을 본 학생별 시청률. 학생 한 명의 시청 기록은 mb_id로 조회합니다.',
    inputSchema: {
        bo_table: z.string().optional(),
        wr_id: z.number().int().min(1).optional(),
        mb_id: z.string().optional().describe('학생 한 명의 게시글 영상 시청 기록'),
        search: z.string().optional().describe('게시글 제목 검색 (bo_table만 줄 때)'),
    },
}, async ({ bo_table, wr_id, mb_id, search }) => {
    if (mb_id) return callApi('GET', 'student-grades.php', { query: { action: 'board-video-watch', mb_id } });
    const mode = !bo_table ? 'boards' : wr_id ? 'viewers' : 'summary';
    return callApi('GET', 'board-video-watch.php', { query: { mode, bo_table, wr_id, search, per_page: 100 } });
});

registerTool('get_group_omr', {
    title: '반별 OMR 성적',
    description: '반(그룹) 학생들의 OMR 응시 현황과 평균 점수를 조회합니다. 시험 종류(게시판)별로 보려면 bo_table을 주세요. 서로 다른 시험 종류의 점수는 섞어 비교하지 마세요.',
    inputSchema: {
        group_id: z.string().min(1).describe('list_students의 groups[].group_id'),
        bo_table: z.string().optional().describe('시험 종류(게시판). 생략하면 반이 응시한 게시판 목록을 먼저 보여줌'),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
    },
}, async ({ group_id, bo_table, from, to }) => {
    if (!bo_table && !from && !to) {
        return callApi('GET', 'student-grades.php', { query: { action: 'group-omr-boards', group_id } });
    }
    return callApi('GET', 'student-grades.php', {
        query: { action: 'group-omr-summary', group_id, bo_table, from_date: from, to_date: to },
    });
});

registerTool('get_site_stats', {
    title: '사이트 현황',
    description: '전체 회원 수, 게시글 수, 오늘/누적 방문자, 최근 가입자·게시글 등 사이트 대시보드 통계를 조회합니다.',
    inputSchema: {},
}, async () => callApi('GET', 'stats.php', { query: { type: 'dashboard' } }));

// ── 게시판 관리 (조회는 모든 키, 생성·수정은 "전체" 권한 키. 삭제는 관리자 화면에서만) ──
const levelSchema = z.number().int().min(1).max(10);
const boardSettingsSchema = {
    bo_subject: z.string().min(1).max(255).optional().describe('게시판 이름'),
    bo_order: z.number().int().optional().describe('출력 순서 (작을수록 앞)'),
    bo_list_level: levelSchema.optional().describe('목록 보기 레벨 (1=비회원 ~ 10=관리자)'),
    bo_read_level: levelSchema.optional().describe('글 읽기 레벨'),
    bo_write_level: levelSchema.optional().describe('글쓰기 레벨'),
    bo_comment_level: levelSchema.optional().describe('댓글 쓰기 레벨'),
    bo_reply_level: levelSchema.optional().describe('답변 쓰기 레벨'),
    bo_use_category: z.boolean().optional().describe('분류 사용 여부'),
    categories: z.array(z.string().min(1)).optional().describe('분류 목록 (예: ["공지","자료"])'),
    bo_page_rows: z.number().int().min(1).max(100).optional().describe('한 페이지 글 수'),
};

function toBoardBody({ bo_use_category, categories, ...rest }) {
    const body = { ...rest };
    if (bo_use_category !== undefined) body.bo_use_category = bo_use_category ? 1 : 0;
    if (categories !== undefined) body.bo_category_list = categories.join('|');
    return body;
}

const pickBoard = (b) => ({
    bo_table: b.bo_table, bo_subject: b.bo_subject, gr_id: b.gr_id, gr_name: b.gr_name, bo_skin: b.bo_skin,
    bo_order: b.bo_order, bo_list_level: b.bo_list_level, bo_read_level: b.bo_read_level,
    bo_write_level: b.bo_write_level, bo_comment_level: b.bo_comment_level, bo_reply_level: b.bo_reply_level,
    bo_use_category: Number(b.bo_use_category) === 1,
    categories: (b.bo_category_list || '').split('|').filter(Boolean),
    bo_page_rows: b.bo_page_rows, bo_count_write: b.bo_count_write,
});

registerTool('list_boards', {
    title: '게시판 목록',
    description: '게시판 목록과 주요 설정(이름, 그룹, 스킨, 권한 레벨, 분류)을 조회합니다. bo_table을 주면 그 게시판 한 개만 봅니다.',
    inputSchema: {
        bo_table: z.string().optional().describe('게시판 아이디 (생략하면 전체 목록)'),
        search: z.string().optional().describe('게시판 아이디/이름 검색'),
    },
}, async ({ bo_table, search }) => {
    if (bo_table) return pickBoard(await callApi('GET', 'boards.php', { query: { bo_table } }));
    const data = await callApi('GET', 'boards.php', { query: { search } });
    const boards = (data.boards || []).map(pickBoard);
    return { total: boards.length, boards };
});

registerTool('create_board', {
    title: '게시판 만들기',
    description: '새 게시판을 만듭니다(기본 스킨). 만들기 전에 아이디·이름·권한 레벨을 사용자에게 보여주고 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        bo_table: z.string().regex(/^[a-z0-9_]{1,20}$/, '영문 소문자·숫자·밑줄 20자 이내').describe('게시판 아이디 (생성 후 변경 불가)'),
        gr_id: z.string().optional().describe('게시판 그룹 (list_boards의 gr_id, 기본 community)'),
        ...boardSettingsSchema,
        bo_subject: z.string().min(1).max(255).describe('게시판 이름'),
    },
}, async (args) => {
    const data = await callApi('POST', 'boards.php', { body: toBoardBody(args) });
    return { bo_table: data.bo_table, bo_subject: data.bo_subject, message: '게시판을 만들었습니다. 스킨 등 세부 설정은 관리자 화면에서 바꿀 수 있습니다.' };
});

registerTool('update_board', {
    title: '게시판 설정 수정',
    description: '게시판 이름·순서·권한 레벨·분류·페이지당 글 수를 바꿉니다. 준 항목만 바뀝니다. 바꾸기 전에 현재 값(list_boards)과 바꿀 값을 사용자에게 보여주고 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        bo_table: z.string().min(1).describe('수정할 게시판 아이디'),
        ...boardSettingsSchema,
    },
}, async ({ bo_table, ...settings }) => {
    const body = toBoardBody(settings);
    if (Object.keys(body).length === 0) throw new Error('바꿀 설정을 하나 이상 주세요.');
    await callApi('PUT', 'boards.php', { query: { bo_table }, body });
    return { bo_table, changed: body, message: '게시판 설정을 수정했습니다.' };
});

// ── 일정·출결·과제·팝업·메인 디자인 쓰기 ("전체" 권한 키. 삭제는 관리자 화면에서만) ──
// 서버 수정 API는 보낸 값으로 전체를 덮어쓰므로, 기존 값을 읽어 바꿀 항목만 합친다.
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM 형식이어야 합니다.');
const dateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/, 'YYYY-MM-DD HH:MM 형식이어야 합니다.');
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const scheduleFields = {
    title: z.string().min(1).max(200).optional().describe('수업 제목'),
    group: z.string().optional().describe('반 이름 (list_students의 group_name)'),
    start_time: timeSchema.optional(),
    end_time: timeSchema.optional(),
    memo: z.string().optional().describe('메모'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('표시 색 (#3b82f6)'),
    is_public: z.boolean().optional().describe('학생에게 공개 (기본 true)'),
};
const toScheduleBody = ({ title, group, start_time, end_time, memo, color, is_public, date }) => defined({
    se_title: title, se_group: group, se_start_time: start_time, se_end_time: end_time,
    se_memo: memo, se_color: color, se_is_public: is_public === undefined ? undefined : Number(is_public), se_date: date,
});

registerTool('create_schedule', {
    title: '수업 일정 만들기',
    description: '수업 일정 한 건을 만듭니다. 만들기 전에 날짜·시간·반·제목을 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: { date: dateSchema, ...scheduleFields, title: z.string().min(1).max(200).describe('수업 제목') },
}, async (args) => callApi('POST', 'schedule.php', { body: toScheduleBody(args) }));

registerTool('update_schedule', {
    title: '수업 일정 수정',
    description: '수업 일정(se_id)을 수정합니다. 준 항목만 바뀝니다. future=true면 반복 일정에서 이 날 이후 같은 묶음을 모두 바꿉니다. 바꾸기 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        se_id: z.number().int().min(1),
        date: dateSchema.optional(),
        ...scheduleFields,
        future: z.boolean().optional().describe('반복 일정의 이후 일정까지 함께 수정'),
    },
}, async ({ se_id, future, ...changes }) => {
    const { event } = await callApi('GET', 'schedule.php', { query: { action: 'event', id: se_id } });
    const body = { ...event, ...toScheduleBody(changes) };
    await callApi('PUT', 'schedule.php', { query: { id: se_id, scope: future ? 'future' : undefined }, body });
    return { se_id, changed: toScheduleBody(changes), message: '일정을 수정했습니다.' };
});

registerTool('toggle_schedule_cancel', {
    title: '휴강 / 휴강 취소',
    description: '수업 일정을 휴강으로 바꾸거나, 이미 휴강이면 휴강을 취소합니다. 설정에 따라 학생에게 휴강 푸시 알림이 나갑니다. 실행 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        se_id: z.number().int().min(1),
        cancel_reason: z.string().optional().describe('휴강 사유'),
    },
}, async ({ se_id, cancel_reason }) => callApi('POST', 'schedule.php', {
    query: { action: 'toggle-cancel', id: se_id }, body: defined({ cancel_reason }),
}));

registerTool('save_attendance', {
    title: '출결 기록',
    description: '수업(se_id)의 학생별 출결을 저장합니다. 이미 기록된 학생은 덮어씁니다. 저장하면 학부모에게 출결 알림톡이 발송됩니다(관리자 화면과 동일). 저장 전에 학생별 출결을 사용자에게 보여주고 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        se_id: z.number().int().min(1).describe('get_schedule의 se_id'),
        records: z.array(z.object({
            mb_id: z.string().min(1),
            status: z.enum(['present', 'absent', 'late', 'excused']).describe('출석/결석/지각/사유결석'),
            memo: z.string().optional(),
        })).min(1),
    },
}, async ({ se_id, records }) => callApi('POST', 'schedule.php', {
    query: { action: 'save-attendance' },
    body: { se_id, records: records.map(({ mb_id, status, memo }) => ({ mb_id, sat_status: status, sat_memo: memo })) },
}));

const linkSchema = z.object({
    title: z.string().min(1),
    url: z.string().url().optional().describe('외부 링크'),
    bo_table: z.string().optional().describe('게시글 링크: 게시판'),
    wr_id: z.number().int().optional().describe('게시글 링크: 글 번호'),
});
const toLinks = (links) => links.map((l) => (l.url
    ? { type: 'external', title: l.title, url: l.url }
    : { type: 'board', title: l.title, bo_table: l.bo_table, wr_id: l.wr_id }));
const assignmentFields = {
    content: z.string().optional().describe('과제 설명'),
    group: z.string().optional().describe('대상 반 이름'),
    members: z.array(z.string().min(1)).optional().describe('대상 학생 mb_id 목록'),
    checklist: z.array(z.string().min(1)).optional().describe('체크리스트 항목'),
    links: z.array(linkSchema).optional().describe('첨부 링크 (url 또는 bo_table+wr_id)'),
    notify: z.boolean().optional().describe('대상 학생에게 사이트 알림·푸시 발송'),
};

registerTool('create_assignment', {
    title: '과제 만들기',
    description: '과제를 만듭니다. 기본으로 대상 학생에게 사이트 알림과 푸시가 발송됩니다(notify=false로 끌 수 있음). 만들기 전에 제목·마감일·대상 학생을 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        title: z.string().min(1).max(255),
        due_date: dateSchema.describe('마감일 YYYY-MM-DD'),
        ...assignmentFields,
        members: z.array(z.string().min(1)).min(1).describe('대상 학생 mb_id 목록 (반 전체면 list_students의 groups[].members)'),
    },
}, async ({ title, due_date, content, group, members, checklist = [], links = [], notify = true }) => callApi('POST', 'assignment.php', {
    query: { action: 'create-assignment' },
    body: {
        as_title: title, as_due_date: due_date, as_content: content, as_student_group: group, as_members: members,
        as_checklist: checklist.map((t) => ({ title: t })), as_links: toLinks(links),
        notify_site: notify, notify_fcm: notify,
    },
}));

registerTool('update_assignment', {
    title: '과제 수정',
    description: '과제(as_id)를 수정합니다. 준 항목만 바뀝니다. 수정 알림은 notify=true일 때만 발송됩니다. 바꾸기 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        as_id: z.number().int().min(1),
        title: z.string().min(1).max(255).optional(),
        due_date: dateSchema.optional(),
        ...assignmentFields,
    },
}, async ({ as_id, title, due_date, content, group, members, checklist, links, notify = false }) => {
    const { assignments = [] } = await callApi('GET', 'assignment.php', { query: { action: 'assignments', as_id, per_page: 1 } });
    const cur = assignments.find((a) => Number(a.as_id) === as_id);
    if (!cur) throw new Error(`과제 ${as_id}를 찾을 수 없습니다.`);
    await callApi('PUT', 'assignment.php', {
        query: { action: 'update-assignment' },
        body: {
            as_id,
            as_title: title ?? cur.as_title,
            as_due_date: due_date ?? cur.as_due_date,
            as_content: content ?? cur.as_content,
            as_student_group: group ?? cur.as_student_group,
            as_members: members ?? (cur.as_members || []).map((m) => m.mb_id),
            as_checklist: checklist ? checklist.map((t) => ({ title: t })) : cur.as_checklist_arr,
            as_links: links ? toLinks(links) : cur.as_links_arr,
            as_status: cur.as_status,
            notify_site: notify, notify_fcm: notify,
        },
    });
    return { as_id, message: '과제를 수정했습니다.' };
});

registerTool('close_assignment', {
    title: '과제 종료',
    description: '과제를 종료(closed) 상태로 바꿉니다. 실행 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: { as_id: z.number().int().min(1) },
}, async ({ as_id }) => callApi('POST', 'assignment.php', { query: { action: 'close-assignment' }, body: { as_id } }));

registerTool('set_assignment_completion', {
    title: '과제 완료 처리',
    description: '학생 한 명의 과제 완료 여부를 바꿉니다(체크리스트 전체 항목도 같이 바뀜). "전체" 권한 키가 필요합니다.',
    inputSchema: {
        as_id: z.number().int().min(1),
        mb_id: z.string().min(1),
        completed: z.boolean(),
    },
}, async (args) => callApi('POST', 'assignment.php', { query: { action: 'update-completion-status' }, body: args }));

const popupFields = {
    subject: z.string().min(1).max(255).optional().describe('팝업 제목 (관리용)'),
    content: z.string().optional().describe('팝업 내용 (HTML)'),
    link: z.string().optional().describe('클릭 시 이동할 주소'),
    device: z.enum(['both', 'pc', 'mobile']).optional(),
    begin_time: dateTimeSchema.optional().describe('노출 시작 YYYY-MM-DD HH:MM'),
    end_time: dateTimeSchema.optional().describe('노출 종료 YYYY-MM-DD HH:MM'),
    width: z.number().int().min(100).max(2000).optional(),
    height: z.number().int().min(100).max(2000).optional(),
    active: z.boolean().optional().describe('노출 여부'),
};
const confirmSchema = z.literal(true).describe('사용자가 삭제를 확인했을 때만 true');
const toPopupForm = (p) => defined({
    nw_subject: p.subject, nw_content: p.content, nw_link: p.link, nw_device: p.device,
    nw_begin_time: p.begin_time, nw_end_time: p.end_time, nw_width: p.width, nw_height: p.height,
    nw_status: p.active === undefined ? undefined : Number(p.active),
});

registerTool('list_popups', {
    title: '팝업 목록',
    description: '사이트 팝업 목록(제목, 유형, 노출 기간, 활성 여부)을 조회합니다.',
    inputSchema: {},
}, async () => (await callApi('GET', 'popup.php', { query: { action: 'list' } }) || []).map((p) => ({ ...p, nw_content: clip(p.nw_content, 500) })));

registerTool('create_popup', {
    title: '팝업 만들기',
    description: '내용(HTML)형 팝업을 만듭니다. 이미지형 팝업은 관리자 화면에서 만드세요. 만들기 전에 제목·내용·노출 기간을 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        ...popupFields,
        subject: z.string().min(1).max(255).describe('팝업 제목 (관리용)'),
        content: z.string().min(1).describe('팝업 내용 (HTML)'),
        begin_time: dateTimeSchema.describe('노출 시작 YYYY-MM-DD HH:MM'),
        end_time: dateTimeSchema.describe('노출 종료 YYYY-MM-DD HH:MM'),
    },
}, async (args) => callApi('POST', 'popup.php', { query: { action: 'create' }, form: { nw_type: 'html', ...toPopupForm(args) } }));

registerTool('update_popup', {
    title: '팝업 수정',
    description: '팝업(nw_id)의 제목·내용·링크·노출 기간·크기·활성 여부를 바꿉니다. 준 항목만 바뀌고 이미지는 그대로 둡니다. 바꾸기 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        nw_id: z.number().int().min(1), ...popupFields,
        delete_image: z.boolean().optional().describe('팝업 이미지 삭제 (최고 관리자 키만, 사용자 확인 필요)'),
    },
}, async ({ nw_id, delete_image, ...changes }) => {
    const cur = await callApi('GET', 'popup.php', { query: { action: 'detail', id: nw_id } });
    const keep = ['nw_type', 'nw_subject', 'nw_content', 'nw_link', 'nw_device', 'nw_begin_time', 'nw_end_time', 'nw_left',
        'nw_top', 'nw_width', 'nw_height', 'nw_new_window', 'nw_show_logged_in', 'nw_disable_options', 'nw_status'];
    const form = { ...defined(Object.fromEntries(keep.map((k) => [k, cur[k] ?? undefined]))), ...toPopupForm(changes) };
    if (delete_image) form.delete_image = '1';
    await callApi('POST', 'popup.php', { query: { action: 'update', id: nw_id }, form });
    return { nw_id, changed: toPopupForm(changes), message: '팝업을 수정했습니다.' };
});

registerTool('get_main_design', {
    title: '메인 페이지 디자인',
    description: '메인 페이지 배너 이미지 파일명, 링크, 배경색, HIJACK 기본 배너 표시 여부를 조회합니다.',
    inputSchema: {},
}, async () => callApi('GET', 'main-page-design.php'));

registerTool('update_main_design', {
    title: '메인 페이지 디자인 수정',
    description: '메인 페이지의 HIJACK 기본 배너 표시, 배너 링크, 배경색을 바꿉니다. 준 항목만 바뀝니다. 이미지 업로드·삭제는 관리자 화면에서 하세요. 바꾸기 전에 사용자에게 확인받으세요. "전체" 권한 키가 필요합니다.',
    inputSchema: {
        default_banner: z.boolean().optional().describe('HIJACK 기본 배너 표시'),
        link_1: z.string().optional(), link_2: z.string().optional(),
        link_1_mobile: z.string().optional(), link_2_mobile: z.string().optional(),
        background_1: z.string().optional().describe('배너 1 배경색 (#ffffff)'),
        background_2: z.string().optional().describe('배너 2 배경색'),
        delete_images: z.array(z.enum(['main_title_1', 'main_title_2', 'main_img_1', 'main_img_2', 'main_img_1_mobile', 'main_img_2_mobile']))
            .optional().describe('삭제할 배너 이미지 (최고 관리자 키만, 사용자 확인 필요)'),
    },
}, async (a) => {
    const form = defined({
        main_default_banner: a.default_banner === undefined ? undefined : (a.default_banner ? '1' : '0'),
        main_link_1: a.link_1, main_link_2: a.link_2, main_link_1_mobile: a.link_1_mobile, main_link_2_mobile: a.link_2_mobile,
        main_background_1: a.background_1, main_background_2: a.background_2,
        ...Object.fromEntries((a.delete_images || []).map((f) => [`delete_${f}`, '1'])),
    });
    if (Object.keys(form).length === 0) throw new Error('바꿀 항목을 하나 이상 주세요.');
    await callApi('POST', 'main-page-design-update.php', { form });
    return { changed: form, message: '메인 페이지 디자인을 수정했습니다.' };
});

// ── 삭제 (최고 관리자 계정의 "전체" 키만. 되돌릴 수 없으므로 confirm=true 필수) ──
// 기존 게시판 아이디에는 대문자가 있다 (예: Keystone_exam). 새로 만들 때만 소문자 규칙 적용
const boTableSchema = z.string().regex(/^[A-Za-z0-9_]{1,20}$/, '영문·숫자·밑줄 20자 이내');
registerTool('delete_schedule', {
    title: '수업 일정 삭제',
    description: '수업 일정(se_id)과 그 일정의 출결·과제 연결을 삭제합니다. future=true면 반복 일정에서 이 날 이후 같은 묶음을 모두 삭제합니다. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: { se_id: z.number().int().min(1), future: z.boolean().optional(), confirm: confirmSchema },
}, async ({ se_id, future }) => {
    await callApi('DELETE', 'schedule.php', { query: { id: se_id, scope: future ? 'future' : undefined } });
    return { se_id, message: future ? '이 날 이후 반복 일정을 삭제했습니다.' : '일정을 삭제했습니다.' };
});

registerTool('delete_assignment', {
    title: '과제 삭제',
    description: '과제(as_id)와 학생별 완료 기록을 삭제합니다. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: { as_id: z.number().int().min(1), confirm: confirmSchema },
}, async ({ as_id }) => {
    await callApi('POST', 'assignment.php', { query: { action: 'delete-assignment' }, body: { as_id } });
    return { as_id, message: '과제를 삭제했습니다.' };
});

registerTool('delete_popup', {
    title: '팝업 삭제',
    description: '팝업(nw_id)과 이미지 파일을 삭제합니다. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: { nw_id: z.number().int().min(1), confirm: confirmSchema },
}, async ({ nw_id }) => {
    await callApi('POST', 'popup.php', { query: { action: 'delete', id: nw_id } });
    return { nw_id, message: '팝업을 삭제했습니다.' };
});

registerTool('delete_report', {
    title: '리포트 삭제',
    description: '학생 리포트(rp_id)를 삭제합니다. 발행된 리포트도 삭제되어 학부모 링크가 끊깁니다. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: { rp_id: z.number().int().min(1), confirm: confirmSchema },
}, async ({ rp_id }) => {
    await callApi('DELETE', 'report.php', { query: { action: 'delete', rp_id } });
    return { rp_id, message: '리포트를 삭제했습니다.' };
});

registerTool('delete_board', {
    title: '게시판 삭제',
    description: '게시판(bo_table)과 그 안의 모든 글을 삭제합니다(테이블 삭제, 복구 불가). 최고 관리자 "전체" 키만 가능하고, 서버에서 스키마 변경이 허용되어 있어야 합니다.',
    inputSchema: { bo_table: boTableSchema, confirm: confirmSchema },
}, async ({ bo_table }) => {
    await callApi('DELETE', 'boards.php', { query: { bo_table } });
    return { bo_table, message: '게시판을 삭제했습니다.' };
});

registerTool('clear_board_posts', {
    title: '게시판 글 비우기',
    description: '게시판(bo_table) 설정은 그대로 두고 글·댓글·첨부파일과 글에 연결된 기록(추천·조회·영상 시청·OMR 결과 등)을 모두 지웁니다. 글 번호는 1부터 다시 시작합니다. 복구 불가. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: { bo_table: boTableSchema, confirm: confirmSchema },
}, async ({ bo_table }) => callApi('POST', 'boards.php', { query: { action: 'clear-posts', bo_table } }));

registerTool('list_menus', {
    title: '메뉴 목록',
    description: '사이트 메뉴(main) 또는 OMR 메뉴(omr)를 조회합니다. me_code가 길수록 하위 메뉴입니다(앞부분이 상위 메뉴 코드).',
    inputSchema: { type: z.enum(['main', 'omr']).optional().describe('기본 main') },
}, async ({ type = 'main' }) => {
    const data = await callApi('GET', 'menus.php', { query: { type: type === 'omr' ? 'omr' : undefined } });
    return (data.flat || []).map(({ me_id, me_code, me_name, me_link, me_order, me_use }) => ({ me_id, me_code, me_name, me_link, me_order, me_use }));
});

registerTool('delete_menu', {
    title: '메뉴 삭제',
    description: '메뉴(me_code)와 그 하위 메뉴를 모두 삭제합니다. 메뉴가 가리키는 게시판은 지우지 않습니다. 최고 관리자 "전체" 키만 가능합니다.',
    inputSchema: {
        me_code: z.string().regex(/^[0-9A-Za-z]+$/).describe('list_menus의 me_code'),
        type: z.enum(['main', 'omr']).optional().describe('기본 main'),
        confirm: confirmSchema,
    },
}, async ({ me_code, type = 'main' }) => {
    await callApi('DELETE', 'menus.php', { query: { me_code, delete_children: 1, type: type === 'omr' ? 'omr' : undefined } });
    return { me_code, message: '메뉴와 하위 메뉴를 삭제했습니다.' };
});

await server.connect(new StdioServerTransport());
console.error(`[hijack-mcp] ${SITE_URL} 연결 준비 완료`);
