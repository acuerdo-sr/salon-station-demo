const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMemberUI({ api, isPages, modal, toast, onChanged, showHistory }) {
  let member = null;
  let mode = 'login';
  let lastEmail = '';
  const content = document.querySelector('#modal-content');
  const notice = isPages
    ? 'このブラウザ内だけで試せるデモ会員機能です。別の端末とは共有されず、本番の本人確認やアクセス制御には使えません。実際の個人情報・パスワードは使用しないでください。'
    : 'このPC内で試すデモ会員機能です。実際の個人情報・パスワードは使用しないでください。メール確認やパスワード再設定は行いません。';

  function setMember(next, mergeGuest = false) {
    const previous = member;
    member = next;
    const button = document.querySelector('#account-button');
    button.querySelector('span').textContent = next ? 'マイページ' : 'ログイン';
    button.setAttribute('aria-label', next ? 'マイページ' : '会員登録・ログイン');
    document.querySelector('#member-status').textContent = next ? `${next.salon} 様としてログイン中` : 'ゲストとしてお買い物中';
    if ((previous?.id ?? null) !== (next?.id ?? null)) onChanged(next, previous, mergeGuest);
  }
  async function refresh() {
    const { member: next } = await api('/auth/me');
    setMember(next);
    return member;
  }
  function showForm(nextMode = 'login') {
    mode = nextMode;
    const register = mode === 'register';
    modal(register ? 'デモ会員登録' : '会員ログイン', `
      <p class="notice">${notice}</p>
      <div class="member-tabs" aria-label="会員メニュー">
        <button type="button" data-member-mode="login" class="${!register ? 'active' : ''}">ログイン</button>
        <button type="button" data-member-mode="register" class="${register ? 'active' : ''}">新規会員登録</button>
      </div>
      <form id="member-form" class="member-form" autocomplete="off">
        ${register ? `<button type="button" class="outline-button sample-fill" data-member-sample>架空の登録情報を入力する</button>
        <div class="form-grid"><label>サロン名（架空）<input name="salon" required maxlength="80" placeholder="デモサロン"></label>
        <label>ご担当者名（架空）<input name="name" required maxlength="80" placeholder="デモ担当者"></label></div>` : ''}
        <label>デモ用メールアドレス<input name="email" type="email" autocomplete="off" required maxlength="150" placeholder="salon-a@example.test" value="${register ? '' : esc(lastEmail)}"></label>
        <p class="field-help">@example.test で終わる架空のアドレスを使用します。</p>
        <label>デモ用パスワード<input name="password" type="password" autocomplete="new-password" required ${register ? 'minlength="12"' : ''} maxlength="128"></label>
        ${register ? `<p class="field-help">12文字以上。普段使っているパスワードは使用しないでください。</p><label>デモ用パスワード（確認）<input name="confirmation" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>` : `<p class="field-help">「架空の登録情報を入力する」を使った場合：<code>Demo-Member-2026</code></p>`}
        <div class="member-error" role="alert"></div>
        <div class="modal-actions"><button type="submit" class="solid-button">${register ? 'デモ会員として登録する' : 'ログインする'}</button></div>
      </form>
      <p class="fine">登録データは${isPages ? 'このブラウザ' : 'このPC'}に保存されます。ログインの有効期間は24時間です。</p>`);
  }
  function showPage() {
    if (!member) return showForm();
    modal('マイページ', `
      <div class="member-welcome"><span class="member-symbol" aria-hidden="true">S</span><div><p class="eyebrow">SALON MEMBER</p><h3>${esc(member.salon)}</h3><p>${esc(member.name)} 様</p></div></div>
      <dl class="member-details"><div><dt>デモ会員番号</dt><dd>SS-${esc(member.id.slice(0, 8).toUpperCase())}</dd></div><div><dt>メールアドレス</dt><dd>${esc(member.email)}</dd></div><div><dt>登録日</dt><dd>${new Date(member.createdAt).toLocaleDateString('ja-JP')}</dd></div></dl>
      <div class="member-actions"><button class="solid-button" type="button" data-member-history>この会員の注文履歴</button><button class="outline-button" type="button" data-member-edit>登録情報を変更</button></div>
      <p class="notice">${notice}</p><p class="fine">会員ごとにカートと注文履歴を分けています。登録前の注文はゲスト注文として残ります。</p>
      <div class="member-error" role="alert"></div><button class="text-button" type="button" data-member-logout>ログアウトする</button>`);
  }
  async function showAccount() {
    try { await refresh(); showPage(); }
    catch (error) { modal('会員情報', `<p class="error">${esc(error.message)}</p>`); }
  }
  function showEdit() {
    if (!member) return showForm();
    modal('登録情報の変更', `<p class="notice">架空のサロン名・ご担当者名を入力してください。注文済みの明細は変更されません。</p><form id="member-profile-form" class="member-form"><label>サロン名（架空）<input name="salon" value="${esc(member.salon)}" required maxlength="80"></label><label>ご担当者名（架空）<input name="name" value="${esc(member.name)}" required maxlength="80"></label><p class="fine">${esc(member.email)}<br>デモではメールアドレスとパスワードの変更は対象外です。</p><div class="member-error" role="alert"></div><div class="modal-actions"><button type="button" class="outline-button" data-member-page>戻る</button><button type="submit" class="solid-button">変更を保存する</button></div></form>`);
  }
  content.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.memberMode) showForm(button.dataset.memberMode);
    if (button.hasAttribute('data-member-page')) showPage();
    if (button.hasAttribute('data-member-edit')) showEdit();
    if (button.hasAttribute('data-member-history')) showHistory();
    if (button.hasAttribute('data-member-sample')) {
      const form = content.querySelector('#member-form');
      form.elements.salon.value = 'デモサロン';
      form.elements.name.value = 'デモ担当者';
      form.elements.email.value = `salon-${crypto.randomUUID().slice(0, 6)}@example.test`;
      form.elements.password.value = 'Demo-Member-2026';
      form.elements.confirmation.value = 'Demo-Member-2026';
      content.querySelector('.member-error').textContent = '架空の情報を入力しました。そのまま登録できます。';
    }
    if (button.hasAttribute('data-member-logout')) {
      button.disabled = true;
      try { await api('/auth/logout', { method: 'POST', body: '{}' }); setMember(null); showForm(); toast('ログアウトしました。'); }
      catch (error) { content.querySelector('.member-error').textContent = error.message; button.disabled = false; }
    }
  });
  content.addEventListener('submit', async event => {
    const form = event.target;
    if (!['member-form', 'member-profile-form'].includes(form.id)) return;
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const data = Object.fromEntries(new FormData(form));
    const errorElement = form.querySelector('.member-error');
    errorElement.textContent = '';
    button.disabled = true;
    try {
      if (form.id === 'member-profile-form') {
        const result = await api('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) });
        setMember(result.member); showPage(); toast('登録情報を保存しました。');
      } else {
        if (mode === 'register' && data.password !== data.confirmation) throw Error('パスワードと確認用パスワードが一致しません。');
        delete data.confirmation;
        const result = await api(mode === 'register' ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(data) });
        lastEmail = result.member.email;
        setMember(result.member, true); showPage(); toast(mode === 'register' ? 'デモ会員登録が完了しました。' : 'ログインしました。');
      }
    } catch (error) { errorElement.textContent = error.message; button.disabled = false; }
  });
  document.querySelector('#account-button').addEventListener('click', showAccount);
  return { current: () => member, refresh, showAccount };
}
