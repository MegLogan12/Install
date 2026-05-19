import { LightningElement, wire, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getDashboardKPIs          from '@salesforce/apex/LovingCustomerSuccessController.getDashboardKPIs';
import getCases                   from '@salesforce/apex/LovingCustomerSuccessController.getCases';
import getUrgentCases             from '@salesforce/apex/LovingCustomerSuccessController.getUrgentCases';
import getWorkOrders              from '@salesforce/apex/LovingCustomerSuccessController.getWorkOrders';
import getServiceAppointments     from '@salesforce/apex/LovingCustomerSuccessController.getServiceAppointments';
import getOmniWork                from '@salesforce/apex/LovingCustomerSuccessController.getOmniWork';
import getPendingApprovals        from '@salesforce/apex/LovingCustomerSuccessController.getPendingApprovals';
import getQuotes                  from '@salesforce/apex/LovingCustomerSuccessController.getQuotes';
import getQuoteLineItems          from '@salesforce/apex/LovingCustomerSuccessController.getQuoteLineItems';
import getBuilderAccounts         from '@salesforce/apex/LovingCustomerSuccessController.getBuilderAccounts';
import getBuilderSummary          from '@salesforce/apex/LovingCustomerSuccessController.getBuilderSummary';
import getKnowledgeArticles       from '@salesforce/apex/LovingCustomerSuccessController.getKnowledgeArticles';
import createCase                 from '@salesforce/apex/LovingCustomerSuccessController.createCase';

const TABS = [
    { id: 0,  key: 'home',         label: 'Home',                  icon: '⊞' },
    { id: 1,  key: 'omni',         label: 'Omni Inbox',            icon: '📥' },
    { id: 2,  key: 'cases',        label: 'Cases',                 icon: '📋' },
    { id: 3,  key: 'builder360',   label: 'Builder 360',           icon: '🏗' },
    { id: 4,  key: 'sitevisits',   label: 'Site Visits',           icon: '📍' },
    { id: 5,  key: 'epo',          label: 'EPO / PO Changes',      icon: '📝' },
    { id: 6,  key: 'warranty',     label: 'Warranty',              icon: '🛡' },
    { id: 7,  key: 'sameday',      label: 'Same-Day',              icon: '⚡' },
    { id: 8,  key: 'closeout',     label: 'Closeout Queue',        icon: '✅' },
    { id: 9,  key: 'knowledge',    label: 'Knowledge + Playbooks', icon: '📖' },
    { id: 10, key: 'reports',      label: 'Reports',               icon: '📊' },
    { id: 11, key: 'approvals',    label: 'Approvals',             icon: '👍' },
    { id: 12, key: 'quotes',       label: 'Quotes + Quote Builder',icon: '💰' },
];

const CASE_TYPE_FILTERS = ['All', 'Warranty', 'EPO', 'Same-Day', 'Closeout', 'Builder Request'];

export default class LovingCustomerSuccessConsoleOverlay extends NavigationMixin(LightningElement) {
    @track activeTab = 0;
    @track caseTypeFilter = 'All';
    @track woStatusFilter = 'All';
    @track saStatusFilter = 'All';
    @track selectedBuilderId = null;
    @track selectedQuoteId = null;
    @track knowledgeSearch = '';
    @track agentforceQuery = '';

    // Wire data holders
    @track kpis = {};
    @track urgentCases = [];
    @track cases = [];
    @track workOrders = [];
    @track serviceAppointments = [];
    @track omniWork = [];
    @track approvals = [];
    @track quotes = [];
    @track quoteLineItems = [];
    @track builderAccounts = [];
    @track builderSummary = {};
    @track knowledgeArticles = [];

    // Error holders
    @track casesError = null;
    @track approvalsError = null;
    @track quotesError = null;

    // ── Wires ───────────────────────────────────────────────────────────────
    @wire(getDashboardKPIs)
    wiredKPIs({ data, error }) {
        if (data) this.kpis = data;
    }

    @wire(getUrgentCases)
    wiredUrgent({ data }) {
        if (data) this.urgentCases = this._enrichCases(data);
    }

    @wire(getCases, { typeFilter: '$caseTypeFilter', maxRows: 50 })
    wiredCases({ data, error }) {
        if (data)  { this.cases = this._enrichCases(data); this.casesError = null; }
        if (error) { this.casesError = error?.body?.message || 'Error loading cases'; }
    }

    @wire(getWorkOrders, { statusFilter: '$woStatusFilter', maxRows: 50 })
    wiredWO({ data }) {
        if (data) this.workOrders = data;
    }

    @wire(getServiceAppointments, { statusFilter: '$saStatusFilter', maxRows: 50 })
    wiredSA({ data }) {
        if (data) this.serviceAppointments = data;
    }

    @wire(getOmniWork)
    wiredOmni({ data }) {
        if (data) this.omniWork = data;
    }

    @wire(getPendingApprovals)
    wiredApprovals({ data, error }) {
        if (data)  { this.approvals = this._enrichApprovals(data); this.approvalsError = null; }
        if (error) { this.approvalsError = error?.body?.message || 'Approvals unavailable'; }
    }

    @wire(getQuotes, { maxRows: 50 })
    wiredQuotes({ data, error }) {
        if (data)  { this.quotes = data; this.quotesError = null; }
        if (error) { this.quotesError = error?.body?.message || 'Error loading quotes'; }
    }

    @wire(getBuilderAccounts, { maxRows: 25 })
    wiredBuilders({ data }) {
        if (data) this.builderAccounts = data;
    }

    @wire(getBuilderSummary, { accountId: '$selectedBuilderId' })
    wiredBuilderSum({ data }) {
        if (data) this.builderSummary = data;
    }

    @wire(getQuoteLineItems, { quoteId: '$selectedQuoteId' })
    wiredLines({ data }) {
        if (data) this.quoteLineItems = data;
    }

    @wire(getKnowledgeArticles, { keywords: '$knowledgeSearch' })
    wiredArticles({ data }) {
        if (data) this.knowledgeArticles = data;
    }

    // ── Computed: tab ribbon ────────────────────────────────────────────────
    get computedTabs() {
        return TABS.map(t => {
            const badge = this._tabBadge(t.id);
            return {
                ...t,
                cls: 'sf-tab' + (this.activeTab === t.id ? ' on' : '') + (badge.urgent ? ' urgent' : ''),
                showBadge: badge.count > 0,
                badgeCount: badge.count,
                badgeCls: 'num-badge',
            };
        });
    }

    _tabBadge(id) {
        const open = v => (typeof v === 'number' && v > 0) ? v : 0;
        if (id === 1) return { count: open(this.omniWork?.length), urgent: false };
        if (id === 2) return { count: open(this.kpis?.openCases), urgent: false };
        if (id === 11) return { count: open(this.kpis?.pendingApprovals), urgent: false };
        return { count: 0, urgent: false };
    }

    // ── Computed: tab visibility ────────────────────────────────────────────
    get isHome()       { return this.activeTab === 0; }
    get isOmni()       { return this.activeTab === 1; }
    get isCases()      { return this.activeTab === 2; }
    get isBuilder360() { return this.activeTab === 3; }
    get isSiteVisits() { return this.activeTab === 4; }
    get isEpo()        { return this.activeTab === 5; }
    get isWarranty()   { return this.activeTab === 6; }
    get isSameDay()    { return this.activeTab === 7; }
    get isCloseout()   { return this.activeTab === 8; }
    get isKnowledge()  { return this.activeTab === 9; }
    get isReports()    { return this.activeTab === 10; }
    get isApprovals()  { return this.activeTab === 11; }
    get isQuotes()     { return this.activeTab === 12; }

    // ── Computed: KPI display values ────────────────────────────────────────
    get kpiOpenCases()      { return this.kpis?.openCases      ?? '—'; }
    get kpiNewToday()       { return this.kpis?.newToday        ?? '—'; }
    get kpiOverdue()        { return this.kpis?.overdueCases    ?? '—'; }
    get kpiOpenWorkOrders() { return this.kpis?.openWorkOrders  ?? '—'; }
    get kpiPendingApprovals(){ return this.kpis?.pendingApprovals ?? '—'; }
    get kpiSiteVisitsWeek() { return this.kpis?.siteVisitsWeek  ?? '—'; }

    // ── Computed: empty states ──────────────────────────────────────────────
    get noUrgentCases()        { return !this.urgentCases?.length; }
    get noCases()              { return !this.cases?.length; }
    get noWorkOrders()         { return !this.workOrders?.length; }
    get noServiceAppts()       { return !this.serviceAppointments?.length; }
    get noOmniWork()           { return !this.omniWork?.length; }
    get noApprovals()          { return !this.approvals?.length; }
    get noQuotes()             { return !this.quotes?.length; }
    get noBuilderAccounts()    { return !this.builderAccounts?.length; }
    get noKnowledgeArticles()  { return !this.knowledgeArticles?.length; }
    get noQuoteLines()         { return !this.quoteLineItems?.length; }
    get hasSelectedBuilder()   { return !!this.selectedBuilderId; }
    get hasSelectedQuote()     { return !!this.selectedQuoteId; }
    get builderOpenCases()     { return this.builderSummary?.openCases ?? 0; }
    get builderOpenWOs()       { return this.builderSummary?.openWorkOrders ?? 0; }
    get builderOpenQuotes()    { return this.builderSummary?.openQuotes ?? 0; }

    // ── Computed: case type filter chips ────────────────────────────────────
    get caseFilterChips() {
        return CASE_TYPE_FILTERS.map(t => ({
            label: t,
            cls: 'filter-chip' + (this.caseTypeFilter === t ? ' on' : ''),
        }));
    }

    // ── Computed: epo / warranty / sameday / closeout cases ────────────────
    get epoCases()      { return this.cases.filter(c => c.Type === 'EPO'); }
    get warrantyCases() { return this.cases.filter(c => c.Type === 'Warranty'); }
    get samedayCases()  { return this.cases.filter(c => c.Type === 'Same-Day'); }
    get closeoutCases() { return this.cases.filter(c => c.Type === 'Closeout'); }
    get noEpoCases()    { return !this.epoCases.length; }
    get noWarrantyCases(){ return !this.warrantyCases.length; }
    get noSamedayCases(){ return !this.samedayCases.length; }
    get noCloseoutCases(){ return !this.closeoutCases.length; }

    // ── Event handlers: tab ─────────────────────────────────────────────────
    handleTabClick(evt) {
        const id = parseInt(evt.currentTarget.dataset.tab, 10);
        this.activeTab = id;
        if (id === 5) this.caseTypeFilter = 'EPO';
        if (id === 6) this.caseTypeFilter = 'Warranty';
        if (id === 7) this.caseTypeFilter = 'Same-Day';
        if (id === 8) this.caseTypeFilter = 'Closeout';
        if (id === 2) this.caseTypeFilter = 'All';
    }

    // ── Event handlers: case filters ────────────────────────────────────────
    handleCaseFilterClick(evt) {
        this.caseTypeFilter = evt.currentTarget.dataset.type;
    }

    // ── Event handlers: record navigation ──────────────────────────────────
    navigateToRecord(evt) {
        const recId = evt.currentTarget.dataset.id;
        if (!recId) return;
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId: recId, actionName: 'view' },
        });
    }

    navigateToNewCase() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'Case', actionName: 'new' },
        });
    }

    navigateToNewWorkOrder() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'WorkOrder', actionName: 'new' },
        });
    }

    navigateToNewServiceAppointment() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'ServiceAppointment', actionName: 'new' },
        });
    }

    navigateToNewQuote() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'Quote', actionName: 'new' },
        });
    }

    navigateToCases() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'Case', actionName: 'list' },
        });
    }

    navigateToReports() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'Report', actionName: 'list' },
        });
    }

    navigateToDashboards() {
        this[NavigationMixin.Navigate]({
            type: 'standard__objectPage',
            attributes: { objectApiName: 'Dashboard', actionName: 'list' },
        });
    }

    // ── Event handlers: builder 360 ─────────────────────────────────────────
    handleBuilderSelect(evt) {
        this.selectedBuilderId = evt.currentTarget.dataset.id;
    }

    handleBuilderDropdown(evt) {
        this.selectedBuilderId = evt.target.value || null;
    }

    // ── Event handlers: quotes ──────────────────────────────────────────────
    handleQuoteSelect(evt) {
        this.selectedQuoteId = evt.currentTarget.dataset.id;
    }

    // ── Event handlers: approvals ───────────────────────────────────────────
    handleApprovalAction(evt) {
        const action = evt.currentTarget.dataset.action;
        const workitemId = evt.currentTarget.dataset.id;
        const targetId = evt.currentTarget.dataset.targetid;

        if (action === 'review' && targetId) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: targetId, actionName: 'view' },
            });
        }
    }

    // ── Event handlers: knowledge ───────────────────────────────────────────
    handleKnowledgeSearch(evt) {
        this.knowledgeSearch = evt.target.value;
    }

    // ── Event handlers: agentforce prompt ──────────────────────────────────
    handleAgentforceInput(evt) {
        this.agentforceQuery = evt.target.value;
    }

    // ── Event handlers: case escalation / reminder ──────────────────────────
    handleEscalateCase(evt) {
        const caseId = evt.currentTarget.dataset.id;
        if (caseId) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: caseId, actionName: 'view' },
            });
        }
    }

    handleSendReminder(evt) {
        const caseId = evt.currentTarget.dataset.id;
        if (caseId) {
            this[NavigationMixin.Navigate]({
                type: 'standard__recordPage',
                attributes: { recordId: caseId, actionName: 'view' },
            });
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────
    _enrichCases(rawCases) {
        return rawCases.map(c => ({
            ...c,
            accountName: c.Account?.Name || '—',
            contactName: c.Contact?.Name || '—',
            statusChipCls: this._statusChipCls(c.Status),
            priorityCls: c.Priority === 'High' ? 'chip cr' : (c.Priority === 'Medium' ? 'chip ca' : 'chip cgr'),
            typeCls: 'chip cgr',
            modifiedLabel: c.LastModifiedDate ? new Date(c.LastModifiedDate).toLocaleDateString() : '—',
        }));
    }

    _statusChipCls(status) {
        if (!status) return 'chip cgr';
        if (['Closed', 'Resolved'].includes(status)) return 'chip cg';
        if (['New'].includes(status)) return 'chip cb2';
        if (['Escalated'].includes(status)) return 'chip cr';
        if (['In Progress', 'Waiting on Customer'].includes(status)) return 'chip ca';
        return 'chip cgr';
    }

    _enrichApprovals(rawApprovals) {
        return rawApprovals.map(a => ({
            ...a,
            targetId: a.ProcessInstance?.TargetObjectId || null,
            submittedBy: a.ProcessInstance?.SubmittedBy?.Name || '—',
            status: a.ProcessInstance?.Status || '—',
            elapsedDays: a.ElapsedTimeInDays != null ? Math.round(a.ElapsedTimeInDays) + 'd' : '—',
            createdLabel: a.CreatedDate ? new Date(a.CreatedDate).toLocaleDateString() : '—',
        }));
    }
}
