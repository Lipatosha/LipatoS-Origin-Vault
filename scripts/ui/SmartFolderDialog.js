import { IS_MAD_EDITION, OV_LAYERS } from '../constants.js';
import { t, tf } from '../utils/i18n.js';
import { appendJQueryToOverlayHost } from '../utils/overlayHost.js';

const TEXT_OPERATORS = ['contains', 'notContains', 'equals', 'notEquals'];
const EXACT_OPERATORS = ['equals', 'notEquals'];
const HAS_OPERATORS = ['has', 'notHas'];
const NUMBER_OPERATORS = ['gte', 'lte', 'equals', 'notEquals'];
const DATE_OPERATORS = ['after', 'before', 'equals', 'notEquals'];

const FIELD_DEFS = [
  { id: 'name', operators: TEXT_OPERATORS, valueType: 'text' },
  { id: 'path', operators: TEXT_OPERATORS, valueType: 'text' },
  { id: 'type', operators: EXACT_OPERATORS, valueType: 'type' },
  { id: 'tag', operators: HAS_OPERATORS, valueType: 'tag' },
  { id: 'untagged', operators: EXACT_OPERATORS, valueType: 'boolean' },
  { id: 'rating', operators: NUMBER_OPERATORS, valueType: 'rating' },
  { id: 'addedDate', operators: DATE_OPERATORS, valueType: 'date' },
  { id: 'lastUsed', operators: DATE_OPERATORS, valueType: 'date' },
  { id: 'folder', operators: HAS_OPERATORS, valueType: 'folder' }
];

const FIELD_MAP = Object.fromEntries(FIELD_DEFS.map(def => [def.id, def]));

export class SmartFolderDialog {
  constructor(app, smartFolder = null) {
    this.app = app;
    this.library = app.library;
    this.smartFolder = smartFolder;
    this.overlay = null;
  }

  static show(app, smartFolder = null) {
    return new SmartFolderDialog(app, smartFolder).show();
  }

  show() {
    return new Promise(resolve => {
      const smartFolder = this.smartFolder || this._createDefaultDraft();
      this.overlay = $(this._renderDialog(smartFolder));

      const close = (value = null) => {
        this.overlay.remove();
        resolve(value);
      };

      this.overlay.on('click', '.ov-dialog-close, .ov-smart-cancel', () => close(null));
      this.overlay.on('click', '.ov-smart-add-rule', () => {
        this._addRuleRow({ field: 'name', operator: 'contains', value: '' });
        this._refreshPreview();
      });
      this.overlay.on('click', '.ov-smart-remove-rule', event => {
        $(event.currentTarget).closest('.ov-smart-rule-row').remove();
        this._refreshPreview();
      });
      this.overlay.on('change', '.ov-smart-rule-field', event => this._onFieldChange(event));
      this.overlay.on('change input', '.ov-smart-rule-operator, .ov-smart-rule-value, .ov-smart-match, .ov-smart-name, .ov-smart-description, .ov-smart-include-subfolders', () => this._refreshPreview());
      this.overlay.on('click', '.ov-smart-save', () => {
        const data = this._readDraft({ onlyCompleteRules: true });
        if (!data.name || data.rules.length === 0) return;

        const saved = this.smartFolder
          ? this.library.updateSmartFolder(this.smartFolder.id, data)
          : this.library.getSmartFolder(this.library.createSmartFolder(data));

        close(saved);
      });
      this.overlay.on('click', event => {
        if (event.target === this.overlay[0]) close(null);
      });

      this.overlay.css({
        position: 'fixed',
        zIndex: String(OV_LAYERS.DIALOG_OVERLAY_BASE + 2)
      });

      appendJQueryToOverlayHost(this.overlay, { owner: this.app });

      const rows = this.overlay.find('.ov-smart-rules');
      for (const rule of smartFolder.rules?.length ? smartFolder.rules : [{ field: 'name', operator: 'contains', value: '' }]) {
        rows.append(this._renderRuleRow(rule));
      }

      this._refreshPreview();
      this.overlay.find('.ov-smart-name').trigger('focus').trigger('select');
    });
  }

  _createDefaultDraft() {
    return {
      name: '',
      description: '',
      match: 'all',
      rules: [{ field: 'name', operator: 'contains', value: '' }]
    };
  }

  _renderDialog(smartFolder) {
    const title = this.smartFolder ? t('origin-vault.smartFolders.edit') : t('origin-vault.smartFolders.new');

    return `
      <div class="ov-dialog-overlay ov-smart-folder-overlay">
        <div class="ov-dialog ov-smart-folder-dialog">
          <div class="ov-dialog-header">
            <h3 class="ov-dialog-title">${this._escape(title)}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content ov-smart-folder-content">
            <label class="ov-smart-label">
              <span>${t('origin-vault.smartFolders.name')}</span>
              <input type="text" class="ov-smart-name" value="${this._escape(smartFolder.name || '')}" autocomplete="off">
            </label>
            <label class="ov-smart-label">
              <span>${t('origin-vault.smartFolders.description')}</span>
              <input type="text" class="ov-smart-description" value="${this._escape(smartFolder.description || '')}" autocomplete="off">
            </label>
            <div class="ov-smart-rule-header">
              <label>
                <span>${t('origin-vault.smartFolders.match')}</span>
                <select class="ov-smart-match">
                  <option value="all" ${smartFolder.match !== 'any' ? 'selected' : ''}>${t('origin-vault.smartFolders.matchAll')}</option>
                  <option value="any" ${smartFolder.match === 'any' ? 'selected' : ''}>${t('origin-vault.smartFolders.matchAny')}</option>
                </select>
              </label>
              <button class="ov-dialog-btn ov-smart-add-rule" type="button">
                <i class="fas fa-plus"></i> ${t('origin-vault.smartFolders.addRule')}
              </button>
            </div>
            <div class="ov-smart-rules"></div>
          </div>
          <div class="ov-dialog-footer ov-smart-footer">
            <span class="ov-smart-preview-count">${tf('origin-vault.smartFolders.matchCount', { count: 0 })}</span>
            <button class="ov-dialog-btn cancel ov-smart-cancel">${t('origin-vault.dialog.cancel')}</button>
            <button class="ov-dialog-btn primary ov-smart-save">${this.smartFolder ? t('origin-vault.dialog.confirm') : t('origin-vault.smartFolders.create')}</button>
          </div>
        </div>
      </div>
    `;
  }

  _addRuleRow(rule) {
    this.overlay.find('.ov-smart-rules').append(this._renderRuleRow(rule));
  }

  _renderRuleRow(rule) {
    const field = FIELD_MAP[rule.field] ? rule.field : 'name';
    const def = FIELD_MAP[field];
    const operator = def.operators.includes(rule.operator) ? rule.operator : def.operators[0];

    return `
      <div class="ov-smart-rule-row">
        <select class="ov-smart-rule-field">
          ${FIELD_DEFS.map(option => `<option value="${option.id}" ${option.id === field ? 'selected' : ''}>${t(`origin-vault.smartFolders.fields.${option.id}`)}</option>`).join('')}
        </select>
        <select class="ov-smart-rule-operator">
          ${this._renderOperatorOptions(def, operator)}
        </select>
        <div class="ov-smart-rule-value-wrap">
          ${this._renderValueControl(def, rule)}
        </div>
        <button class="ov-smart-remove-rule" type="button" title="${t('origin-vault.smartFolders.removeRule')}">
          <i class="fas fa-minus"></i>
        </button>
      </div>
    `;
  }

  _renderOperatorOptions(def, selectedOperator) {
    return def.operators
      .map(operator => `<option value="${operator}" ${operator === selectedOperator ? 'selected' : ''}>${t(`origin-vault.smartFolders.operators.${operator}`)}</option>`)
      .join('');
  }

  _renderValueControl(def, rule) {
    const value = rule.value ?? '';

    if (def.valueType === 'type') {
      const types = [
        { id: 'image', label: t('origin-vault.fileTypes.image') },
        { id: 'video', label: t('origin-vault.fileTypes.video') },
        { id: 'audio', label: t('origin-vault.fileTypes.audio') },
        { id: 'scene', label: t('origin-vault.fileTypes.scene') },
        { id: 'item', label: t('origin-vault.fileTypes.item') },
        { id: 'actor', label: t('origin-vault.fileTypes.actor') }
      ].filter(type => !IS_MAD_EDITION || type.id === 'scene');
      return `<select class="ov-smart-rule-value">${this._renderOptionList(types, value || types[0]?.id)}</select>`;
    }

    if (def.valueType === 'tag') {
      const tags = Object.values(this.library.getAllTags?.() || this.library.tags || {})
        .map(tag => ({ id: tag.id, label: tag.name }));
      return `<select class="ov-smart-rule-value">${this._renderOptionList(tags, value)}</select>`;
    }

    if (def.valueType === 'folder') {
      const folders = this._getFolderOptions();
      return `
        <select class="ov-smart-rule-value">${this._renderOptionList(folders, value)}</select>
        <label class="ov-smart-subfolder-check">
          <input type="checkbox" class="ov-smart-include-subfolders" ${rule.includeSubfolders !== false ? 'checked' : ''}>
          ${t('origin-vault.smartFolders.includeSubfolders')}
        </label>
      `;
    }

    if (def.valueType === 'boolean') {
      return `
        <select class="ov-smart-rule-value">
          <option value="true" ${String(value || 'true') !== 'false' ? 'selected' : ''}>${t('origin-vault.smartFolders.values.true')}</option>
          <option value="false" ${String(value) === 'false' ? 'selected' : ''}>${t('origin-vault.smartFolders.values.false')}</option>
        </select>
      `;
    }

    if (def.valueType === 'rating') {
      return `<input type="number" min="0" max="5" step="1" class="ov-smart-rule-value" value="${this._escape(value || 4)}">`;
    }

    if (def.valueType === 'date') {
      return `<input type="date" class="ov-smart-rule-value" value="${this._escape(this._dateValue(value))}">`;
    }

    return `<input type="text" class="ov-smart-rule-value" value="${this._escape(value)}" autocomplete="off">`;
  }

  _renderOptionList(options, selectedValue) {
    if (options.length === 0) {
      return `<option value="">${t('origin-vault.smartFolders.noOptions')}</option>`;
    }

    const selected = String(selectedValue || options[0]?.id || '');
    return options
      .map(option => `<option value="${this._escape(option.id)}" ${String(option.id) === selected ? 'selected' : ''}>${this._escape(option.label)}</option>`)
      .join('');
  }

  _getFolderOptions() {
    const folders = this.library.getAllFolders();
    const result = [];
    const visit = (folderId, depth = 0) => {
      const folder = folders[folderId];
      if (!folder) return;
      if (folderId !== 'root') {
        result.push({
          id: folderId,
          label: `${'  '.repeat(depth)}${folder.name || folderId}`
        });
      }
      for (const childId of folder.children || []) {
        visit(childId, depth + 1);
      }
    };
    visit('root');
    return result;
  }

  _onFieldChange(event) {
    const row = $(event.currentTarget).closest('.ov-smart-rule-row');
    const field = event.currentTarget.value;
    const def = FIELD_MAP[field] || FIELD_MAP.name;

    row.find('.ov-smart-rule-operator').html(this._renderOperatorOptions(def, def.operators[0]));
    row.find('.ov-smart-rule-value-wrap').html(this._renderValueControl(def, {
      field,
      operator: def.operators[0],
      value: def.valueType === 'rating' ? 4 : ''
    }));
    this._refreshPreview();
  }

  _readDraft({ onlyCompleteRules = false } = {}) {
    const rules = [];

    this.overlay.find('.ov-smart-rule-row').each((_, el) => {
      const row = $(el);
      const field = row.find('.ov-smart-rule-field').val();
      const operator = row.find('.ov-smart-rule-operator').val();
      const value = row.find('.ov-smart-rule-value').val();
      const rule = {
        field,
        operator,
        value,
        includeSubfolders: row.find('.ov-smart-include-subfolders').prop('checked') !== false
      };

      if (!onlyCompleteRules || this._isCompleteRule(rule)) {
        rules.push(rule);
      }
    });

    return {
      name: String(this.overlay.find('.ov-smart-name').val() || '').trim(),
      description: String(this.overlay.find('.ov-smart-description').val() || '').trim(),
      match: this.overlay.find('.ov-smart-match').val() === 'any' ? 'any' : 'all',
      rules
    };
  }

  _isCompleteRule(rule) {
    if (!rule.field) return false;
    if (rule.field === 'untagged') return true;
    return rule.value !== undefined && rule.value !== null && String(rule.value).trim() !== '';
  }

  _refreshPreview() {
    const draft = this._readDraft({ onlyCompleteRules: true });
    const count = draft.rules.length ? this.library.getItemsBySmartFolderData(draft).length : 0;
    const canSave = draft.name.length > 0 && draft.rules.length > 0;

    this.overlay.find('.ov-smart-preview-count').text(tf('origin-vault.smartFolders.matchCount', { count }));
    this.overlay.find('.ov-smart-save').prop('disabled', !canSave);
  }

  _dateValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  _escape(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
