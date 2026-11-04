// Пока firebase = null, сайт работает в демо-режиме: данные только в этом браузере.
// Как заполнить, написано в README.md (шаг 3).
export const config = {
  // Объект firebaseConfig из консоли Firebase.
  firebase: {
    apiKey: 'AIzaSyBy9iWtnXF-KuTgd-7VxHdmIGuLlDCrbhE',
    authDomain: 'wishlist-8f306.firebaseapp.com',
    projectId: 'wishlist-8f306',
    storageBucket: 'wishlist-8f306.firebasestorage.app',
    messagingSenderId: '988934964762',
    appId: '1:988934964762:web:c2e6849d2f5eded820f3a3',
  },

  // Что показывать, пока именинник не заполнил настройки в панели.
  defaults: {
    title: 'Вишлист Сэма',
    text: 'Выбирай подарок и пиши своё имя: можно забронировать его целиком или скинуться вместе с другими.',
    date: '',
  },
};
