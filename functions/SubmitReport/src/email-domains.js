// Known disposable / throwaway email domains — block on sight.
// Maintained manually; add new domains as they appear in abuse logs.
export const DISPOSABLE_DOMAINS = new Set([
  // Major throwaway services
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamail.de', 'grr.la', 'guerrillamailblock.com', 'tempmail.com',
  'temp-mail.org', 'temp-mail.io', 'throwaway.email', 'throwaway.me',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'sharklasers.com',
  'guerrillamail.info', 'spam4.me', 'trashmail.com', 'trashmail.me',
  'trashmail.net', 'trashmail.org', 'trashmail.io', 'trashymail.com',
  'dispostable.com', 'mailnesia.com', 'maildrop.cc', 'discard.email',
  'discardmail.com', 'discardmail.de', 'fakeinbox.com', 'fakemail.net',
  'tempail.com', 'tempr.email', 'tempmailaddress.com', 'tmpmail.net',
  'tmpmail.org', 'temptasticmail.com', 'getnada.com', 'nada.email',

  // 10minutemail and variants
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  '10minute.email', '10minut.xyz', 'minutemail.com',
  'minuteinbox.com', 'emailondeck.com',

  // Guerrilla clones & aliases
  'bccto.me', 'clrmail.com', 'getairmail.com', 'mailcatch.com',

  // Burner / anonymous services
  'burnermail.io', 'burnmail.ca', 'inboxkitten.com', 'mailsac.com',
  'harakirimail.com', 'mailnull.com', 'mailslurp.com',
  'mohmal.com', 'emailfake.com', 'emkei.cz', 'crazymailing.com',

  // Trash/spam catchers
  'spamgourmet.com', 'spamgourmet.net', 'spamgourmet.org',
  'mytemp.email', 'jetable.org', 'mailexpire.com',
  'notsharingmy.info', 'notmailinator.com',
  'spamfree24.org', 'trashcanmail.com', 'mailzilla.com',

  // Popular temp mail services
  'mailtemp.net', 'mail.tm', 'mail-temporaire.fr',
  'emailtemporanea.com', 'emailtemporanea.net',
  'emailtemporario.com.br', 'tempomail.fr',
  'tempsky.com', 'tempmails.net',

  // Generator services
  'fakemailgenerator.com', 'armyspy.com', 'cuvox.de', 'dayrep.com',
  'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com',
  'rhyta.com', 'superrito.com', 'teleworm.us',

  // Recent / trendy disposable services
  'cock.li', 'tfwno.gf', 'airmail.cc', 'firemail.cc',
  'getbackinthe.kitchen', 'memeware.net', 'national.shitposting.agency',
  'wants.dickr.us', 'horsefucker.org',

  // Russian/international throwaway
  'mailbox.in.ua', 'tempmail.it', 'wegwerfmail.de', 'wegwerfmail.net',
  'trash-mail.at', 'trash-mail.com', 'byom.de',

  // MailDrop alternatives
  'mailforspam.com', 'safetymail.info', 'filzmail.com',

  // Inbox generators
  'inboxes.com', 'inboxbear.com', 'nowmymail.com',
  'owlpic.com', 'sharklasers.com', 'spam4.me',
  'grr.la', 'guerrillamail.biz',

  // More recent services (2024-2026)
  'tmailor.com', 'tmails.net', 'tempinbox.com',
  'disposableemailaddresses.emailmiser.com',
  'anonymbox.com', 'anonbox.net',
  'mailinator.net', 'mailinator.org',
  'sogetthis.com', 'mailinater.com', 'mailinator2.com',
  'reallymymail.com', 'reconmail.com',
  'tempmailo.com', 'tempmailbox.net',
]);

// Well-known email providers — skip the per-domain account cap for these.
export const ALLOWED_PROVIDERS = new Set([
  // Google
  'gmail.com', 'googlemail.com',

  // Microsoft
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it',
  'outlook.co.uk', 'outlook.fr', 'outlook.de', 'outlook.com.au',

  // Yahoo
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de',
  'yahoo.co.jp', 'yahoo.com.br', 'yahoo.ca', 'yahoo.com.au',
  'ymail.com', 'rocketmail.com',

  // Apple
  'icloud.com', 'me.com', 'mac.com',

  // Privacy-focused (legitimate)
  'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tuta.io',
  'fastmail.com', 'fastmail.fm',

  // ISPs (large)
  'comcast.net', 'verizon.net', 'att.net', 'cox.net', 'charter.net',
  'sbcglobal.net', 'bellsouth.net', 'earthlink.net',
  'btinternet.com', 'sky.com', 'virgin.net', 'ntlworld.com',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr',
  't-online.de', 'web.de', 'gmx.de', 'gmx.net', 'gmx.com',
  'mail.ru', 'yandex.ru', 'yandex.com',
  'qq.com', '163.com', '126.com', 'sina.com',
  'naver.com', 'daum.net', 'hanmail.net',

  // Other well-known
  'zoho.com', 'zohomail.com', 'aol.com', 'aim.com',
  'mail.com', 'email.com', 'usa.com',
]);
