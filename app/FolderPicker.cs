using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
static class FolderPicker {
 [STAThread] static int Main(string[] args) {
  if(args.Length!=1)return 2;
  try {
   Application.EnableVisualStyles();
   Application.SetCompatibleTextRenderingDefault(false);
   using(var form=new Form()) {
   form.Text="项目资料台 2.1 · 开始使用";
   form.ClientSize=new Size(500,275);form.StartPosition=FormStartPosition.CenterScreen;
   form.FormBorderStyle=FormBorderStyle.FixedDialog;form.MaximizeBox=false;form.MinimizeBox=false;
   form.Font=new Font("Microsoft YaHei UI",10);
   form.Controls.Add(new Label {Text="从自己的工作开始。\r\n选择资料文件夹，或先建一份空白计划。",Location=new Point(28,25),Size=new Size(445,58)});
   var pick=new Button {Text="选择已有资料文件夹",Location=new Point(28,100),Size=new Size(444,45)};
   pick.Click+=(sender,e)=>{using(var dialog=new FolderBrowserDialog {Description="选择自己的资料文件夹，可包含多层子目录",ShowNewFolderButton=true}) {if(dialog.ShowDialog(form)==DialogResult.OK){form.Tag=dialog.SelectedPath;form.DialogResult=DialogResult.OK;form.Close();}}};
   form.Controls.Add(pick);
   var blank=new Button {Text="先建空白计划",Location=new Point(28,157),Size=new Size(444,45)};
   blank.Click+=(sender,e)=>{form.Tag="__EMPTY__";form.DialogResult=DialogResult.OK;form.Close();};
   form.Controls.Add(blank);
   form.Controls.Add(new Label {Text="项目和待办从空白开始，之后可以关联资料。",Location=new Point(28,222),Size=new Size(444,28),ForeColor=Color.DimGray});
   var selection=form.ShowDialog()==DialogResult.OK?(string)form.Tag:"";
   File.WriteAllText(args[0],selection,new UTF8Encoding(false));
   }
   return 0;
  } catch(Exception error) {
   try{File.WriteAllText(args[0]+".error.txt",error.ToString(),new UTF8Encoding(false));}catch{}
   return 1;
  }
 }
}
