import {createRef} from 'react';
import type {ComponentProps} from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import {UiPreferencesProvider} from '@/shared/context/UiPreferencesContext';
vi.mock('@/modules/chat/hooks/useVoiceAvailable',()=>({useVoiceAvailable:()=>false}));
vi.mock('@/modules/chat/hooks/useVoiceInput',()=>({useVoiceInput:()=>({state:'idle',toggle:()=>{},stop:()=>{}})}));
const noop=()=>{};
afterEach(cleanup);
function props(file:File){return {
 pendingPermissionRequests:[],activity:null,isLoading:false,permissionMode:'default',availablePermissionModes:['default'],onSelectPermissionMode:noop,providerLabel:'Codex',effort:'medium',availableEffortOptions:[],onSelectEffort:noop,model:'test',availableModelOptions:[],onSelectModel:noop,modelsLoading:false,tokenBudget:null,onShowTokenUsage:noop,slashCommandsCount:0,onToggleCommandMenu:noop,hasInput:true,onClearInput:noop,onSubmit:vi.fn(),isDragActive:false,queuedDraft:null,isEditingSentMessage:false,onCancelEditMessage:noop,scheduledMessages:[],onScheduleMessage:noop,onCancelScheduledMessage:noop,onEditQueuedDraft:noop,onDeleteQueuedDraft:noop,attachedFiles:[file],onRemoveAttachment:noop,fileErrors:new Map(),showFileDropdown:false,filteredFiles:[],selectedFileIndex:0,onSelectFile:noop,filteredCommands:[],selectedCommandIndex:0,onCommandSelect:noop,onCloseCommandMenu:noop,isCommandMenuOpen:false,frequentCommands:[],getRootProps:()=>({}),getInputProps:()=>({}),openAttachmentPicker:noop,inputHighlightRef:createRef<HTMLDivElement>(),renderInputWithMentions:(value:string)=>value,textareaRef:createRef<HTMLTextAreaElement>(),input:'read this',onInputChange:noop,onTextareaClick:noop,onTextareaKeyDown:noop,onTextareaPaste:noop,onTextareaScrollSync:noop,onTextareaInput:noop,placeholder:'Message',isTextareaExpanded:false
} as unknown as ComponentProps<typeof ChatComposer>;}
for(const type of ['text/plain','image/png'])test(`${type} disables sending for missing, compressing, uploading and failed states; ready enables it`,()=>{
 Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:preview'),revokeObjectURL:vi.fn()});
 const file=new File(['file'],'attachment',{type}),base=props(file);
 const ui=(status?:'compressing'|'uploading'|'error'|'ready')=><UiPreferencesProvider><ChatComposer {...base} attachmentUploadStates={new Map(status?[[file,{status,progress:status==='ready'?100:50}]]:[])}/></UiPreferencesProvider>;
 const view=render(ui());
 for(const status of [undefined,'compressing','uploading','error'] as const){
  view.rerender(ui(status));const button=screen.getByRole('button',{name:'附件上传完成后才能发送'}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(button);expect(base.onSubmit).not.toHaveBeenCalled();
 }
 view.rerender(ui('ready'));const send=view.container.querySelector('button[type="submit"]') as HTMLButtonElement;expect(send.disabled).toBe(false);
});
